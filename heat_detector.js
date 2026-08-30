/**
 * heat_detector.js
 *
 * Direct port of vision/heat_detector.py to OpenCV.js, running the exact
 * same 12-stage pipeline in the browser instead of on-device Python:
 *
 *   1. Downscale, 2-3. HSV threshold, 4. morphology open/close,
 *   5. connected-component denoise, 6. contour detection,
 *   7. surface detection (edges -> largest contour -> polygon),
 *   8. erode surface, 9. subtract dilated hot regions,
 *   10. largest remaining usable region -> placement zone,
 *   11. temporal smoothing, 12. composite overlays onto the ORIGINAL frame.
 *
 * HONESTY NOTE (same as the Python original): this never measures real
 * temperature. It's a visual heuristic over hue/saturation/brightness -
 * "Visual Heat Estimation", never "temperature measurement".
 *
 * cv.Mat is manually memory-managed (WASM heap), so every Mat created
 * here is explicitly .delete()'d once it's no longer needed - this runs
 * every animation frame, so leaks show up fast as rising memory/crashes.
 */

class DetectionResult {
  constructor(frame, hotDetected, placementRecommended, confidence, surfaceFound) {
    this.frame = frame; // cv.Mat, RGBA, same size as input, caller owns it
    this.hotDetected = hotDetected;
    this.placementRecommended = placementRecommended;
    this.confidence = confidence;
    this.surfaceFound = surfaceFound;
  }
}

class HeatRegionDetector {
  // Colors in RGB + full alpha (Python used BGR since it composited with
  // cv2 directly; here we work in RGBA throughout, same visual colors).
  static COLOR_HOT = [255, 60, 60, 255];
  static COLOR_PLACEMENT = [110, 230, 90, 255];
  static COLOR_SURFACE_EDGE = [230, 230, 230, 255];

  constructor(processWidth = 320) {
    this.processWidth = processWidth;
    this.sensitivity = 50;
    this.overlayOpacity = 0.45;

    this._hotMaskSmoother = new MaskSmoother(0.4);
    this._placementMaskSmoother = new MaskSmoother(0.3);
    this._confidenceSmoother = new ValueSmoother(0.25);

    this._kOpen = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    this._kClose = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
    this._kHotDilate = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));

    this._lastHotMaskFull = null;
    this._lastPlacementMaskFull = null;
    this._lastSurfaceContourFull = null; // cv.Mat of points, or null
  }

  setSensitivity(v) {
    this.sensitivity = Math.min(100, Math.max(0, v));
  }

  setOverlayOpacity(v) {
    this.overlayOpacity = Math.min(1, Math.max(0, v));
  }

  reset() {
    this._hotMaskSmoother.reset();
    this._placementMaskSmoother.reset();
    this._confidenceSmoother.reset();
  }

  /**
   * frameRGBA: cv.Mat, CV_8UC4, full-resolution captured frame.
   * Returns a DetectionResult whose .frame the caller owns (must delete).
   */
  process(frameRGBA) {
    const h = frameRGBA.rows, w = frameRGBA.cols;

    // --- 1. Resize down ------------------------------------------------
    const scale = this.processWidth / w;
    const procW = this.processWidth;
    const procH = Math.max(1, Math.round(h * scale));
    const small = new cv.Mat();
    cv.resize(frameRGBA, small, new cv.Size(procW, procH), 0, 0, cv.INTER_AREA);

    // --- 2 & 3. HSV threshold -------------------------------------------
    const hotMaskSmall0 = this._thresholdHotRegions(small);

    // --- 4. Morphological open then close --------------------------------
    const hotMaskSmall1 = new cv.Mat();
    cv.morphologyEx(hotMaskSmall0, hotMaskSmall1, cv.MORPH_OPEN, this._kOpen);
    hotMaskSmall0.delete();
    const hotMaskSmall2 = new cv.Mat();
    cv.morphologyEx(hotMaskSmall1, hotMaskSmall2, cv.MORPH_CLOSE, this._kClose);
    hotMaskSmall1.delete();

    // --- 5. Connected-component denoise -----------------------------------
    const minHotArea = 0.0015 * procW * procH;
    const hotMaskSmall = this._filterSmallComponents(hotMaskSmall2, minHotArea);
    hotMaskSmall2.delete();

    // --- 6. Contour detection on the cleaned heat mask ----------------------
    const hotContours = new cv.MatVector();
    const hierTmp = new cv.Mat();
    cv.findContours(hotMaskSmall, hotContours, hierTmp, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    hierTmp.delete();
    let hotDetected = false;
    for (let i = 0; i < hotContours.size(); i++) {
      if (cv.contourArea(hotContours.get(i)) >= minHotArea) { hotDetected = true; break; }
    }
    hotContours.delete();

    // --- 7. Surface detection ------------------------------------------------
    const { mask: surfaceMaskSmall, found: surfaceFound } = this._detectSurface(small);
    small.delete();

    // --- 8. Erode the surface mask (edge-safe region) -------------------------
    const insetPx = Math.max(3, Math.round(Math.min(procW, procH) * 0.05));
    const kInset = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(insetPx, insetPx));
    const surfaceEroded = new cv.Mat();
    cv.erode(surfaceMaskSmall, surfaceEroded, kInset);
    kInset.delete();

    // --- 9. Remove hot regions (dilated, safety margin) -------------------------
    const hotDilated = new cv.Mat();
    cv.dilate(hotMaskSmall, hotDilated, this._kHotDilate);
    const hotDilatedInv = new cv.Mat();
    cv.bitwise_not(hotDilated, hotDilatedInv);
    hotDilated.delete();
    const usable = new cv.Mat();
    cv.bitwise_and(surfaceEroded, hotDilatedInv, usable);
    surfaceEroded.delete();
    hotDilatedInv.delete();

    // --- 10. Largest remaining usable region -> placement zone -------------------
    const minPlaceArea = 0.01 * procW * procH;
    const { mask: placementMaskSmallRaw, area: placementArea } = this._largestComponentMask(usable, minPlaceArea);
    usable.delete();

    const surfaceArea = Math.max(cv.countNonZero(surfaceMaskSmall), 1);
    let confidenceRaw;
    if (placementMaskSmallRaw !== null) {
      confidenceRaw = 100 * (placementArea / surfaceArea);
      confidenceRaw = Math.min(98, Math.max(5, confidenceRaw));
    } else {
      confidenceRaw = 0;
    }

    // --- 11. Temporal smoothing -------------------------------------------------
    const hotMaskSmoothed = this._hotMaskSmoother.update(hotMaskSmall);
    hotMaskSmall.delete();

    let placementMaskSmoothed;
    if (placementMaskSmallRaw !== null) {
      placementMaskSmoothed = this._placementMaskSmoother.update(placementMaskSmallRaw);
      placementMaskSmallRaw.delete();
    } else {
      const blank = new cv.Mat(procH, procW, cv.CV_8UC1, new cv.Scalar(0));
      placementMaskSmoothed = this._placementMaskSmoother.update(blank);
      blank.delete();
    }
    const confidence = this._confidenceSmoother.update(confidenceRaw);
    const placementRecommended = confidenceRaw > 0 &&
      cv.countNonZero(placementMaskSmoothed) > minPlaceArea * 0.5;

    // --- Scale masks back up to display resolution --------------------------------
    const hotMaskFull = new cv.Mat();
    cv.resize(hotMaskSmoothed, hotMaskFull, new cv.Size(w, h), 0, 0, cv.INTER_NEAREST);
    hotMaskSmoothed.delete();
    const placementMaskFull = new cv.Mat();
    cv.resize(placementMaskSmoothed, placementMaskFull, new cv.Size(w, h), 0, 0, cv.INTER_NEAREST);
    placementMaskSmoothed.delete();

    let surfaceContourFull = null;
    if (surfaceFound) {
      const c = this._maskToContour(surfaceMaskSmall);
      if (c !== null) {
        surfaceContourFull = this._scaleContour(c, 1 / scale);
        c.delete();
      }
    }
    surfaceMaskSmall.delete();

    // --- 12. Composite overlays onto the ORIGINAL frame -----------------------------
    const composited = this._compositeOverlays(frameRGBA, hotMaskFull, surfaceContourFull, placementMaskFull);

    if (this._lastHotMaskFull) this._lastHotMaskFull.delete();
    if (this._lastPlacementMaskFull) this._lastPlacementMaskFull.delete();
    if (this._lastSurfaceContourFull) this._lastSurfaceContourFull.delete();
    this._lastHotMaskFull = hotMaskFull;
    this._lastPlacementMaskFull = placementMaskFull;
    this._lastSurfaceContourFull = surfaceContourFull;

    return new DetectionResult(composited, hotDetected, placementRecommended, confidence, surfaceFound);
  }

  /** Cheap path: re-blend cached masks onto a freshly captured frame. */
  recomposite(frameRGBA) {
    if (!this._lastHotMaskFull && !this._lastPlacementMaskFull) {
      return frameRGBA.clone();
    }
    const h = frameRGBA.rows, w = frameRGBA.cols;
    let hot = this._lastHotMaskFull, hotOwned = false;
    let placement = this._lastPlacementMaskFull, placementOwned = false;
    if (hot && (hot.rows !== h || hot.cols !== w)) {
      const r = new cv.Mat();
      cv.resize(hot, r, new cv.Size(w, h), 0, 0, cv.INTER_NEAREST);
      hot = r; hotOwned = true;
    }
    if (placement && (placement.rows !== h || placement.cols !== w)) {
      const r = new cv.Mat();
      cv.resize(placement, r, new cv.Size(w, h), 0, 0, cv.INTER_NEAREST);
      placement = r; placementOwned = true;
    }
    const out = this._compositeOverlays(frameRGBA, hot, this._lastSurfaceContourFull, placement);
    if (hotOwned) hot.delete();
    if (placementOwned) placement.delete();
    return out;
  }

  // --------------------------------------------------------------------------
  // Stage implementations
  // --------------------------------------------------------------------------

  _thresholdHotRegions(rgbaSmall) {
    const rgb = new cv.Mat();
    cv.cvtColor(rgbaSmall, rgb, cv.COLOR_RGBA2RGB);
    const hsv = new cv.Mat();
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    rgb.delete();

    const sens = this.sensitivity / 100.0;
    const clip = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    let satMin = Math.round(150 - sens * 95);
    let valMin = Math.round(150 - sens * 75);
    satMin = clip(satMin, 40, 200);
    valMin = clip(valMin, 60, 200);

    const hueUpper1 = clip(Math.round(22 + sens * 20), 20, 45);
    const mask1 = new cv.Mat();
    {
      const lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, satMin, valMin, 0]);
      const hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [hueUpper1, 255, 255, 255]);
      cv.inRange(hsv, lo, hi, mask1);
      lo.delete(); hi.delete();
    }

    const hueLower2 = clip(Math.round(168 - sens * 8), 155, 179);
    const mask2 = new cv.Mat();
    {
      const lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [hueLower2, satMin, valMin, 0]);
      const hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [179, 255, 255, 255]);
      cv.inRange(hsv, lo, hi, mask2);
      lo.delete(); hi.delete();
    }

    const glowValMin = clip(Math.round(235 - sens * 40), 190, 250);
    const mask3 = new cv.Mat();
    {
      const lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 0, glowValMin, 0]);
      const hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [45, 255, 255, 255]);
      cv.inRange(hsv, lo, hi, mask3);
      lo.delete(); hi.delete();
    }
    hsv.delete();

    const combined1 = new cv.Mat();
    cv.bitwise_or(mask1, mask2, combined1);
    mask1.delete(); mask2.delete();
    const combined2 = new cv.Mat();
    cv.bitwise_or(combined1, mask3, combined2);
    combined1.delete(); mask3.delete();

    return combined2;
  }

  _detectSurface(rgbaSmall) {
    const h = rgbaSmall.rows, w = rgbaSmall.cols;
    const gray = new cv.Mat();
    cv.cvtColor(rgbaSmall, gray, cv.COLOR_RGBA2GRAY);
    const blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    gray.delete();
    const edges0 = new cv.Mat();
    cv.Canny(blurred, edges0, 40, 120);
    blurred.delete();
    const kDilate = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    const edges = new cv.Mat();
    cv.dilate(edges0, edges, kDilate, new cv.Point(-1, -1), 2);
    edges0.delete(); kDilate.delete();

    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    cv.findContours(edges, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    edges.delete(); hier.delete();

    const minSurfaceArea = 0.15 * w * h;
    let candidateIdx = -1, candidateArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const area = cv.contourArea(contours.get(i));
      if (area > candidateArea) { candidateArea = area; candidateIdx = i; }
    }

    const mask = new cv.Mat(h, w, cv.CV_8UC1, new cv.Scalar(0));
    if (candidateIdx >= 0 && candidateArea >= minSurfaceArea) {
      const candidate = contours.get(candidateIdx);
      const perimeter = cv.arcLength(candidate, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(candidate, approx, 0.02 * perimeter, true);
      const polys = new cv.MatVector();
      polys.push_back(approx);
      cv.fillPoly(mask, polys, new cv.Scalar(255, 255, 255, 255));
      approx.delete(); polys.delete();
      contours.delete();
      return { mask, found: true };
    }
    contours.delete();

    // Fallback: whole frame minus a margin.
    const marginX = Math.round(w * 0.04);
    const marginY = Math.round(h * 0.04);
    cv.rectangle(mask, new cv.Point(marginX, marginY), new cv.Point(w - marginX, h - marginY),
      new cv.Scalar(255, 255, 255, 255), -1);
    return { mask, found: false };
  }

  _filterSmallComponents(binaryMask, minArea) {
    const labels = new cv.Mat();
    const stats = new cv.Mat();
    const centroids = new cv.Mat();
    const numLabels = cv.connectedComponentsWithStats(binaryMask, labels, stats, centroids, 8, cv.CV_32S);
    centroids.delete();

    const cleaned = new cv.Mat(binaryMask.rows, binaryMask.cols, cv.CV_8UC1, new cv.Scalar(0));
    for (let label = 1; label < numLabels; label++) {
      const area = stats.intPtr(label, 4)[0]; // CC_STAT_AREA column
      if (area >= minArea) {
        for (let i = 0; i < labels.rows * labels.cols; i++) {
          if (labels.data32S[i] === label) cleaned.data[i] = 255;
        }
      }
    }
    labels.delete(); stats.delete();
    return cleaned;
  }

  _largestComponentMask(binaryMask, minArea) {
    const labels = new cv.Mat();
    const stats = new cv.Mat();
    const centroids = new cv.Mat();
    const numLabels = cv.connectedComponentsWithStats(binaryMask, labels, stats, centroids, 8, cv.CV_32S);
    centroids.delete();

    let bestLabel = -1, bestArea = 0;
    for (let label = 1; label < numLabels; label++) {
      const area = stats.intPtr(label, 4)[0];
      if (area >= minArea && area > bestArea) { bestLabel = label; bestArea = area; }
    }
    stats.delete();

    if (bestLabel === -1) {
      labels.delete();
      return { mask: null, area: 0 };
    }

    const mask = new cv.Mat(binaryMask.rows, binaryMask.cols, cv.CV_8UC1, new cv.Scalar(0));
    for (let i = 0; i < labels.rows * labels.cols; i++) {
      if (labels.data32S[i] === bestLabel) mask.data[i] = 255;
    }
    labels.delete();
    return { mask, area: bestArea };
  }

  _maskToContour(binaryMask) {
    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    cv.findContours(binaryMask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    hier.delete();
    if (contours.size() === 0) { contours.delete(); return null; }
    let bestIdx = 0, bestArea = cv.contourArea(contours.get(0));
    for (let i = 1; i < contours.size(); i++) {
      const a = cv.contourArea(contours.get(i));
      if (a > bestArea) { bestArea = a; bestIdx = i; }
    }
    const best = contours.get(bestIdx).clone();
    contours.delete();
    return best;
  }

  _scaleContour(contour, factor) {
    const out = contour.clone();
    const d = out.data32S;
    for (let i = 0; i < d.length; i++) d[i] = Math.round(d[i] * factor);
    return out;
  }

  // Composites overlays onto the ORIGINAL frame - kept semi-transparent
  // so the live image always stays visible underneath.
  _compositeOverlays(baseRGBA, hotMaskFull, surfaceContour, placementMaskFull) {
    const overlay = baseRGBA.clone();

    const hotPresent = hotMaskFull && cv.countNonZero(hotMaskFull) > 0;
    if (hotPresent) {
      overlay.setTo(new cv.Scalar(...HeatRegionDetector.COLOR_HOT), hotMaskFull);
    }

    const placementPresent = placementMaskFull && cv.countNonZero(placementMaskFull) > 0;
    if (placementPresent) {
      overlay.setTo(new cv.Scalar(...HeatRegionDetector.COLOR_PLACEMENT), placementMaskFull);
    }

    const blended = new cv.Mat();
    cv.addWeighted(overlay, this.overlayOpacity, baseRGBA, 1 - this.overlayOpacity, 0, blended);
    overlay.delete();

    if (surfaceContour !== null) {
      const polys = new cv.MatVector();
      polys.push_back(surfaceContour);
      cv.polylines(blended, polys, true, new cv.Scalar(...HeatRegionDetector.COLOR_SURFACE_EDGE), 2, cv.LINE_AA);
      polys.delete();
    }

    if (placementPresent) {
      const contours = new cv.MatVector();
      const hier = new cv.Mat();
      cv.findContours(placementMaskFull, contours, hier, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE);
      hier.delete();
      if (contours.size() > 0) {
        cv.polylines(blended, contours, true, new cv.Scalar(...HeatRegionDetector.COLOR_PLACEMENT), 2, cv.LINE_AA);
      }
      contours.delete();
    }

    return blended;
  }
}
