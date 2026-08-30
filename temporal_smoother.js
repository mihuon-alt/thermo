/**
 * temporal_smoother.js
 *
 * Direct port of vision/temporal_smoother.py's MaskSmoother and
 * ValueSmoother. (PolygonSmoother isn't used by the main pipeline, so
 * it's not ported - the mask-level smoothing is what heat_detector.py
 * actually uses.)
 *
 * MaskSmoother keeps a plain Float32Array accumulator (not a cv.Mat) so
 * there's no OpenCV memory-management overhead for something this simple;
 * it converts to/from cv.Mat only at the boundary.
 */

class MaskSmoother {
  constructor(alpha = 0.35) {
    this.alpha = alpha;
    this._acc = null; // Float32Array, values in [0,255]
    this._w = 0;
    this._h = 0;
  }

  reset() {
    this._acc = null;
  }

  /**
   * mat: cv.Mat, CV_8UC1, values 0 or 255.
   * Returns a NEW cv.Mat, CV_8UC1, values 0 or 255. Caller owns it (must
   * call .delete() when done).
   */
  update(mat) {
    const w = mat.cols, h = mat.rows;
    const src = mat.data; // Uint8Array view, length w*h

    if (this._acc === null || this._w !== w || this._h !== h) {
      this._acc = new Float32Array(w * h);
      for (let i = 0; i < src.length; i++) this._acc[i] = src[i];
      this._w = w; this._h = h;
    } else {
      const a = this.alpha, inv = 1 - a;
      const acc = this._acc;
      for (let i = 0; i < src.length; i++) {
        acc[i] = a * src[i] + inv * acc[i];
      }
    }

    const out = new cv.Mat(h, w, cv.CV_8UC1);
    const dst = out.data;
    const acc = this._acc;
    for (let i = 0; i < dst.length; i++) {
      dst[i] = acc[i] > 127 ? 255 : 0;
    }
    return out;
  }
}

class ValueSmoother {
  constructor(alpha = 0.2) {
    this.alpha = alpha;
    this._value = null;
  }

  reset() {
    this._value = null;
  }

  update(value) {
    if (this._value === null) {
      this._value = value;
    } else {
      this._value = this.alpha * value + (1 - this.alpha) * this._value;
    }
    return this._value;
  }
}
