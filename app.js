/**
 * ThermoCell Vision - browser/PWA camera + OpenCV controller.
 *
 * Camera access is intentionally treated as a separate permission state:
 * - "prompt": call getUserMedia() and let the browser ask
 * - "granted": open the camera
 * - "denied": do NOT spam getUserMedia(); explain how to reset the site permission
 *
 * Important: getUserMedia() cannot override a browser/site-level denial.
 * A web page also cannot universally open browser permission settings.
 */

(() => {
  'use strict';

  const screenCamera = document.getElementById('screen-camera');
  const screenPermission = document.getElementById('screen-permission');
  const video = document.getElementById('video');
  const canvas = document.getElementById('output');

  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const statusHot = document.getElementById('status-hot');
  const statusPlace = document.getElementById('status-place');
  const statusConf = document.getElementById('status-conf');

  const btnScan = document.getElementById('btn-scan');
  const btnPause = document.getElementById('btn-pause');
  const btnReset = document.getElementById('btn-reset');
  const btnFlip = document.getElementById('btn-flip');
  const btnTorch = document.getElementById('btn-torch');
  const btnRetry = document.getElementById('btn-retry');
  const btnOpenTab = document.getElementById('btn-open-tab');
  const permError = document.getElementById('perm-error');
  const permHelp = document.getElementById('perm-help');

  const sensSlider = document.getElementById('sens-slider');
  const sensVal = document.getElementById('sens-val');
  const opacSlider = document.getElementById('opac-slider');
  const opacVal = document.getElementById('opac-val');

  let detector = null;
  let stream = null;
  let track = null;
  let frontCamera = false;
  let torchOn = false;
  let torchSupported = false;
  let paused = false;
  let scanRequested = false;
  let running = false;
  let cvReady = false;
  let cap = null;
  let frameMat = null;
  let permissionStatus = null;
  let requestingCamera = false;
  let firstCameraAttempted = false;
  let rawCanvasCtx = null;

  function setStatus(text) {
    statusText.textContent = text;
    statusDot.classList.toggle('live', text === 'LIVE');
  }

  function showPermScreen() {
    screenCamera.classList.add('hidden');
    screenPermission.classList.remove('hidden');
  }

  function hidePermScreen() {
    screenPermission.classList.add('hidden');
    screenCamera.classList.remove('hidden');
  }

  function setPermissionMessage(message, help = '') {
    permError.textContent = message || '';
    permHelp.textContent = help || '';
  }

  function currentPageUrl() {
    return window.location.href;
  }

  function isEmbedded() {
    try {
      return window.self !== window.top;
    } catch (_) {
      return true;
    }
  }

  function openInTopLevelTab() {
    const url = currentPageUrl();
    try {
      window.top.location.href = url;
    } catch (_) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  // ------------------------------------------------------------------
  // Permission state
  // ------------------------------------------------------------------
  async function queryCameraPermission() {
    if (!navigator.permissions?.query) return 'unknown';

    try {
      permissionStatus = await navigator.permissions.query({ name: 'camera' });
      if (permissionStatus) {
        permissionStatus.onchange = () => {
          updatePermissionUi(permissionStatus.state);
        };
      }
      return permissionStatus.state;
    } catch (err) {
      console.info('ThermoCellVision: camera permission query unavailable:', err);
      return 'unknown';
    }
  }

  function updatePermissionUi(state) {
    if (state === 'granted') {
      btnRetry.textContent = 'START CAMERA';
      setPermissionMessage(
        cvReady ? 'Camera permission is granted.' : 'Camera permission is granted; waiting for the detection engine.',
        ''
      );
      return;
    }

    if (state === 'denied') {
      btnRetry.textContent = 'CHECK AGAIN';
      setPermissionMessage(
        'Camera permission is blocked for this site.',
        'Tap the lock/tune icon beside the address bar → Site settings → Camera → Allow, then return here and tap CHECK AGAIN. The app cannot change a browser-level denial itself.'
      );
      return;
    }

    if (state === 'prompt') {
      btnRetry.textContent = 'ALLOW CAMERA';
      setPermissionMessage(
        'Camera permission has not been decided yet.',
        'Tap ALLOW CAMERA and choose Allow when your browser asks for camera access.'
      );
      return;
    }

    btnRetry.textContent = 'TRY AGAIN';
  }

  // ------------------------------------------------------------------
  // Camera acquisition / permission flow
  // ------------------------------------------------------------------
  function buildPrimaryConstraints() {
    return {
      audio: false,
      video: {
        facingMode: { ideal: frontCamera ? 'user' : 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    };
  }

  function buildFallbackConstraints() {
    // Some cameras/browsers reject a facing-mode constraint even though
    // getUserMedia itself is available. Fall back to "any video camera".
    return { audio: false, video: true };
  }

  async function requestCamera({forcePrompt = false} = {}) {
    if (requestingCamera) return;
    requestingCamera = true;
    firstCameraAttempted = true;

    setStatus('INITIALIZING');
    showPermScreen();

    if (isEmbedded()) {
      setPermissionMessage(
        'This page is running inside an embedded preview.',
        'Camera permission often cannot be requested from an embedded preview. Open the deployed HTTPS URL in a normal browser tab, then tap ALLOW CAMERA.',
      );
      btnOpenTab.hidden = false;
      requestingCamera = false;
      return;
    }
    btnOpenTab.hidden = true;

    if (!window.isSecureContext) {
      setPermissionMessage(
        'Camera access requires HTTPS (or localhost).',
        'Use your GitHub Pages HTTPS URL, not an HTTP preview URL.'
      );
      requestingCamera = false;
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setPermissionMessage(
        'This browser does not expose getUserMedia().',
        'Use a current Chrome, Edge, Firefox, or Safari browser over HTTPS.'
      );
      requestingCamera = false;
      return;
    }

    const state = await queryCameraPermission();

    if (state === 'denied' && !forcePrompt) {
      updatePermissionUi('denied');
      requestingCamera = false;
      return;
    }

    if (state === 'prompt') {
      updatePermissionUi('prompt');
    }

    // Stop an old stream before asking for a new one.
    stopCamera();

    let newStream = null;
    try {
      try {
        newStream = await navigator.mediaDevices.getUserMedia(buildPrimaryConstraints());
      } catch (primaryErr) {
        // Don't hide an actual permission denial. A fallback is useful only
        // for constraint/hardware-selection failures.
        const retryable = ['OverconstrainedError', 'ConstraintNotSatisfiedError', 'NotFoundError'].includes(primaryErr?.name);
        if (!retryable) throw primaryErr;
        console.info('ThermoCellVision: retrying with generic camera constraints:', primaryErr);
        newStream = await navigator.mediaDevices.getUserMedia(buildFallbackConstraints());
      }

      stream = newStream;
      track = stream.getVideoTracks()[0];
      if (!track) throw new DOMException('No video track returned.', 'NotFoundError');

      const caps = track.getCapabilities ? track.getCapabilities() : {};
      torchSupported = !!caps.torch;
      torchOn = false;
      btnTorch.disabled = !torchSupported;
      btnTorch.classList.remove('active');

      video.srcObject = stream;
      await video.play();

      // CAMERA SUCCESS IS THE UI SUCCESS STATE. Do not wait for OpenCV.
      // The user must see the live camera immediately even if the detection
      // engine is still loading, unavailable, or temporarily broken.
      hidePermScreen();
      setPermissionMessage('');
      ensureRawCanvas();

      video.addEventListener('loadedmetadata', onVideoReady, { once: true });
      video.addEventListener('canplay', onVideoReady, { once: true });
      if (video.videoWidth && video.videoHeight) onVideoReady();
    } catch (err) {
      console.warn('ThermoCellVision: camera start failed:', err);
      stopCamera();
      await handleCameraError(err);
    } finally {
      requestingCamera = false;
    }
  }

  async function handleCameraError(err) {
    const name = err?.name || 'UnknownError';

    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      await queryCameraPermission();
      updatePermissionUi('denied');
      return;
    }

    if (name === 'NotFoundError') {
      setPermissionMessage(
        'No camera was found.',
        'Check that your device has a camera and that another app is not exclusively using it.'
      );
      return;
    }

    if (name === 'NotReadableError') {
      setPermissionMessage(
        'The camera is already in use or could not be opened.',
        'Close other camera/video apps or browser tabs, then tap TRY AGAIN.'
      );
      return;
    }

    if (name === 'OverconstrainedError') {
      setPermissionMessage(
        'The selected camera mode is not supported.',
        'Try FLIP CAM or tap TRY AGAIN to use a simpler camera request.'
      );
      return;
    }

    if (name === 'AbortError') {
      setPermissionMessage(
        'Camera startup was interrupted.',
        'Tap TRY AGAIN.'
      );
      return;
    }

    setPermissionMessage(
      `Camera error: ${name}${err?.message ? ` — ${err.message}` : ''}`,
      'Check site permissions and reload the page if the problem continues.'
    );
  }

  function showPermError(msg) {
    setPermissionMessage(msg);
    showPermScreen();
  }

  function ensureRawCanvas() {
    if (!rawCanvasCtx) rawCanvasCtx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    return !!rawCanvasCtx;
  }

  function drawRawFrame() {
    if (!ensureRawCanvas()) return false;
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    try {
      rawCanvasCtx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return true;
    } catch (err) {
      console.warn('ThermoCellVision: raw camera draw failed:', err);
      return false;
    }
  }

  function startRawLoop() {
    if (!running) {
      running = true;
      requestAnimationFrame(loop);
    }
  }

  function onVideoReady() {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      setStatus('INITIALIZING');
      startRawLoop();
      return;
    }

    // Always render the real camera first. Detection is an optional second stage.
    canvas.width = width;
    canvas.height = height;
    ensureRawCanvas();
    drawRawFrame();
    hidePermScreen();

    if (!cvReady || typeof cv === 'undefined' || !cv.Mat) {
      setStatus('LIVE');
      startRawLoop();
      return;
    }

    try {
      if (frameMat) { frameMat.delete(); frameMat = null; }
      frameMat = new cv.Mat(height, width, cv.CV_8UC4);
      cap = new cv.VideoCapture(video);
      if (!detector) detector = new HeatRegionDetector(320);
      setStatus('LIVE');
      startRawLoop();
    } catch (err) {
      console.error('ThermoCellVision: detection engine init failed; keeping raw camera live:', err);
      cap = null;
      if (frameMat) { try { frameMat.delete(); } catch (_) {} frameMat = null; }
      setStatus('LIVE');
      startRawLoop();
    }
  }

  function stopCamera() {
    running = false;

    if (stream) {
      stream.getTracks().forEach((t) => {
        try { t.stop(); } catch (_) {}
      });
      stream = null;
    }

    track = null;
    torchOn = false;

    if (frameMat) {
      try { frameMat.delete(); } catch (_) {}
      frameMat = null;
    }
    cap = null;

    if (video.srcObject) {
      try { video.pause(); } catch (_) {}
      video.srcObject = null;
    }
  }

  // ------------------------------------------------------------------
  // Main capture / detect / draw loop
  // ------------------------------------------------------------------
  function loop() {
    if (!running) return;

    // Raw camera is the guaranteed baseline. Never let detector failures make the screen black.
    if (video.readyState >= 2 && video.videoWidth > 0) {
      if (!(paused && cap && detector)) {
        const rawDrawn = drawRawFrame();
        if (!rawDrawn && !cap) setStatus('INITIALIZING');
      }
    }

    if (cap && frameMat && detector && video.readyState >= 2 && video.videoWidth > 0) {
      if (!(paused && !scanRequested)) {
        let result = null;
        try {
          const ok = cap.read(frameMat);
          if (!ok) throw new Error('OpenCV VideoCapture.read() returned false');

          if (scanRequested) detector.reset();
          result = detector.process(frameMat);
          scanRequested = false;

          cv.imshow(canvas, result.frame);
          pushStats(result.hotDetected, result.placementRecommended, result.confidence);
          setStatus(paused ? 'PAUSED' : 'LIVE');
        } catch (err) {
          console.error('ThermoCellVision: CV frame processing failed; raw camera remains visible:', err);
          cap = null;
          if (frameMat) { try { frameMat.delete(); } catch (_) {} frameMat = null; }
          drawRawFrame();
          setStatus('LIVE');
          statusHot.textContent = 'DETECTION STARTING';
          statusPlace.textContent = 'PLACEMENT: SEARCHING...';
          statusConf.textContent = 'CONFIDENCE: 00%';
          if (scanRequested) scanRequested = false;
        } finally {
          if (result?.frame) {
            try { result.frame.delete(); } catch (_) {}
          }
        }
      }
    }

    requestAnimationFrame(loop);
  }

  function pushStats(hotDetected, placementRecommended, confidence) {
    statusHot.textContent = hotDetected ? 'HOT REGION DETECTED' : 'NO HOT REGION VISIBLE';
    statusHot.classList.toggle('hot', hotDetected);
    statusHot.classList.toggle('dim', !hotDetected);

    statusPlace.textContent = placementRecommended ? 'PLACEMENT: RECOMMENDED' : 'PLACEMENT: SEARCHING...';
    statusPlace.classList.toggle('place', placementRecommended);
    statusPlace.classList.toggle('dim', !placementRecommended);

    statusConf.textContent = `CONFIDENCE: ${String(Math.round(confidence)).padStart(2, '0')}%`;
  }

  // ------------------------------------------------------------------
  // UI wiring
  // ------------------------------------------------------------------
  btnScan.addEventListener('click', () => {
    scanRequested = true;
  });

  btnPause.addEventListener('click', () => {
    paused = !paused;
    btnPause.textContent = paused ? 'RESUME' : 'PAUSE';
    setStatus(paused ? 'PAUSED' : 'LIVE');
  });

  btnReset.addEventListener('click', () => {
    detector?.reset();
  });

  btnFlip.addEventListener('click', async () => {
    frontCamera = !frontCamera;
    stopCamera();
    await requestCamera({ forcePrompt: true });
  });

  btnTorch.addEventListener('click', async () => {
    if (!torchSupported || !track) return;

    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      torchOn = next;
      btnTorch.classList.toggle('active', torchOn);
    } catch (err) {
      console.info('ThermoCellVision: torch failed:', err);
      torchSupported = false;
      torchOn = false;
      btnTorch.classList.remove('active');
      btnTorch.disabled = true;
      setPermissionMessage('This camera does not expose torch control.', 'The camera itself is still available.');
      hidePermScreen();
    }
  });

  btnRetry.addEventListener('click', async () => {
    const state = await queryCameraPermission();

    // Once a site permission was changed to Allow, this click immediately
    // opens the camera. If still denied, we explain why another prompt cannot
    // be forced from JavaScript.
    if (state === 'granted') {
      await requestCamera({ forcePrompt: true });
      return;
    }

    await requestCamera({ forcePrompt: state !== 'denied' });
  });

  btnOpenTab.addEventListener('click', openInTopLevelTab);

  sensSlider.addEventListener('input', () => {
    sensVal.textContent = `${sensSlider.value}%`;
    detector?.setSensitivity(Number(sensSlider.value));
  });

  opacSlider.addEventListener('input', () => {
    opacVal.textContent = `${opacSlider.value}%`;
    detector?.setOverlayOpacity(Number(opacSlider.value) / 100);
  });

  window.addEventListener('beforeunload', stopCamera);

  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) {
      stopCamera();
      return;
    }
    if (!stream && cvReady) {
      const state = await queryCameraPermission();
      if (state !== 'denied') await requestCamera({ forcePrompt: state !== 'denied' });
      else updatePermissionUi('denied');
    }
  });

  // ------------------------------------------------------------------
  // PWA service worker
  // ------------------------------------------------------------------
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './' })
        .then((registration) => {
          console.info('ThermoCellVision: service worker registered:', registration.scope);
        })
        .catch((err) => {
          console.warn('ThermoCellVision: service worker registration failed:', err);
        });
    });
  }

  // ------------------------------------------------------------------
  // OpenCV.js readiness / boot
  // ------------------------------------------------------------------
  setPermissionMessage(
    'Loading detection engine (OpenCV.js)...',
    'After it finishes, tap ALLOW CAMERA. The browser will ask for camera permission.'
  );

  const cvTimeout = setTimeout(() => {
    if (!cvReady) {
      setPermissionMessage(
        'OpenCV.js is taking longer than expected.',
        'Check your internet connection and make sure docs.opencv.org is reachable, then reload.'
      );
    }
  }, 15000);

  whenCvReady(() => {
    cvReady = true;
    clearTimeout(cvTimeout);

    try {
      detector = detector || new HeatRegionDetector(320);
    } catch (err) {
      console.error('ThermoCellVision: OpenCV detector initialization failed:', err);
      detector = null;
    }
    sensVal.textContent = `${sensSlider.value}%`;
    opacVal.textContent = `${opacSlider.value}%`;

    // If the camera was already opened while OpenCV was loading, upgrade the
    // live raw feed to the processed pipeline now—without asking permission again.
    if (stream && video.videoWidth && video.videoHeight) onVideoReady();

    // Query permission first. "prompt" gets a single automatic request after
    // the engine is ready; "denied" gets an actionable settings message.
    queryCameraPermission().then((state) => {
      updatePermissionUi(state);
      if (state === 'prompt' && !firstCameraAttempted) {
        requestCamera({ forcePrompt: true });
      } else if (state === 'granted' && !firstCameraAttempted) {
        requestCamera({ forcePrompt: true });
      }
    });
  });

  function whenCvReady(cb) {
    if (typeof cv !== 'undefined' && cv.Mat) {
      cb();
      return;
    }
    window.addEventListener('opencv-ready', cb, { once: true });
  }
})();
