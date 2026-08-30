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
  let cameraActive = false;
  let cameraStartToken = 0;

  const CameraPermission = window.CameraPermission || {
    normalizePermissionState: (state) => {
      if (state === 'granted' || state === 'denied' || state === 'prompt') return state;
      return 'unknown';
    },
    canRequestCamera: ({ permissionState, forcePrompt = false, isEmbedded = false, isSecureContext = false, mediaDevicesSupported = false } = {}) => {
      const state = this && this.normalizePermissionState ? this.normalizePermissionState(permissionState) : (
        permissionState === 'granted' || permissionState === 'denied' || permissionState === 'prompt' ? permissionState : 'unknown'
      );
      if (isEmbedded) return { allowed: false, reason: 'embedded', state };
      if (!isSecureContext) return { allowed: false, reason: 'insecure', state };
      if (!mediaDevicesSupported) return { allowed: false, reason: 'missing-api', state };
      if (state === 'denied' && !forcePrompt) return { allowed: false, reason: 'denied', state };
      return { allowed: true, reason: 'request', state };
    },
    getPermissionRecoveryCopy: () => ({
      denied: { title: 'Camera permission is blocked for this site.', help: 'Tap the lock or tune icon beside the address bar → Site settings → Camera → Allow, then return here and tap CHECK AGAIN. The app cannot change a browser-level denial itself.' },
      embedded: { title: 'This page is running inside an embedded preview.', help: 'Open the deployed HTTPS URL in a normal browser tab, then tap ALLOW CAMERA.' },
      insecure: { title: 'Camera access requires HTTPS.', help: 'Use the GitHub Pages HTTPS URL instead of an HTTP or preview URL.' }
    })
  };

  function setStatus(text) {
    statusText.textContent = text;
    statusDot.classList.toggle('live', text === 'LIVE');
  }

  function showPermScreen() {
    console.log('ThermoCellVision: showing permission screen');
    screenCamera.classList.add('hidden');
    screenPermission.classList.remove('hidden');
  }

  function hidePermScreen() {
    console.log('ThermoCellVision: hiding permission screen and showing camera view');
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
      return CameraPermission.normalizePermissionState(permissionStatus?.state || 'unknown');
    } catch (err) {
      console.info('ThermoCellVision: camera permission query unavailable:', err);
      return 'unknown';
    }
  }

  function updatePermissionUi(state) {
    const safeState = CameraPermission.normalizePermissionState(state);

    if (safeState === 'granted') {
      btnRetry.textContent = 'START CAMERA';
      setPermissionMessage(
        cvReady ? 'Camera permission is granted.' : 'Camera permission is granted; waiting for the detection engine.',
        ''
      );
      return;
    }

    if (safeState === 'denied') {
      btnRetry.textContent = 'CHECK AGAIN';
      setPermissionMessage(
        'Camera permission is blocked for this site.',
        'Tap the lock or tune icon beside the address bar → Site settings → Camera → Allow, then return here and tap CHECK AGAIN. The app cannot change a browser-level denial itself.'
      );
      return;
    }

    if (safeState === 'prompt') {
      btnRetry.textContent = 'ALLOW CAMERA';
      setPermissionMessage(
        'Camera permission has not been decided yet.',
        'Tap ALLOW CAMERA and choose Allow when your browser asks for camera access.'
      );
      return;
    }

    btnRetry.textContent = 'TRY AGAIN';
    setPermissionMessage(
      'Camera permission is not confirmed yet.',
      'Tap TRY AGAIN to re-check. If the browser blocks the request, the site permission must be changed in your browser settings.'
    );
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
    if (requestingCamera) {
      console.log('ThermoCellVision: camera request already in progress; ignoring duplicate start');
      return;
    }
    if (cameraActive && stream && video.srcObject) {
      console.log('ThermoCellVision: camera already active; ignoring duplicate start');
      hidePermScreen();
      return;
    }

    const requestToken = ++cameraStartToken;
    requestingCamera = true;
    firstCameraAttempted = true;

    console.log('ThermoCellVision: requestCamera start', { requestToken, forcePrompt, cameraActive, isEmbedded: isEmbedded(), isSecureContext: window.isSecureContext });
    setStatus('INITIALIZING');
    showPermScreen();

    const permissionDecision = CameraPermission.canRequestCamera({
      permissionState: permissionStatus?.state || 'unknown',
      forcePrompt,
      isEmbedded: isEmbedded(),
      isSecureContext: window.isSecureContext,
      mediaDevicesSupported: !!navigator.mediaDevices?.getUserMedia,
    });

    if (!permissionDecision.allowed) {
      const recovery = CameraPermission.getPermissionRecoveryCopy()[permissionDecision.reason] || {
        title: 'Camera access is unavailable right now.',
        help: 'Use the browser permission controls to allow access, then tap CHECK AGAIN.'
      };
      console.warn('ThermoCellVision: requestCamera blocked before getUserMedia()', { requestToken, reason: permissionDecision.reason, state: permissionDecision.state });
      setPermissionMessage(recovery.title, recovery.help);
      btnOpenTab.hidden = permissionDecision.reason !== 'embedded';
      if (permissionDecision.reason === 'denied') {
        btnRetry.textContent = 'CHECK AGAIN';
      }
      requestingCamera = false;
      return;
    }
    btnOpenTab.hidden = true;

    const state = await queryCameraPermission();
    console.log('ThermoCellVision: permission check result', { requestToken, state, forcePrompt });
    const decision = CameraPermission.canRequestCamera({
      permissionState: state,
      forcePrompt,
      isEmbedded: isEmbedded(),
      isSecureContext: window.isSecureContext,
      mediaDevicesSupported: !!navigator.mediaDevices?.getUserMedia,
    });

    if (!decision.allowed) {
      const recovery = CameraPermission.getPermissionRecoveryCopy()[decision.reason] || {
        title: 'Camera access is unavailable right now.',
        help: 'Use the browser permission controls to allow access, then tap CHECK AGAIN.'
      };
      console.warn('ThermoCellVision: requestCamera blocked after permission query', { requestToken, reason: decision.reason, state: decision.state });
      setPermissionMessage(recovery.title, recovery.help);
      if (decision.reason === 'denied') updatePermissionUi('denied');
      else if (decision.reason === 'embedded') btnOpenTab.hidden = false;
      requestingCamera = false;
      return;
    }

    if (state === 'prompt') {
      updatePermissionUi('prompt');
    }

    stopCamera();

    let newStream = null;
    try {
      try {
        console.log('ThermoCellVision: requesting getUserMedia with primary constraints', { requestToken, frontCamera });
        newStream = await navigator.mediaDevices.getUserMedia(buildPrimaryConstraints());
      } catch (primaryErr) {
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

      console.log('ThermoCellVision: getUserMedia succeeded', { requestToken, streamId: stream.id, trackCount: stream.getVideoTracks().length, readyState: video.readyState });

      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.setAttribute('playsinline', 'true');
      video.setAttribute('autoplay', 'true');

      video.onloadedmetadata = () => {
        console.log('ThermoCellVision: video loadedmetadata', { width: video.videoWidth, height: video.videoHeight, readyState: video.readyState });
      };
      video.oncanplay = () => {
        console.log('ThermoCellVision: video canplay', { width: video.videoWidth, height: video.videoHeight, readyState: video.readyState });
      };

      try {
        await video.play();
        console.log('ThermoCellVision: video.play() succeeded; camera startup complete');
      } catch (playErr) {
        console.warn('ThermoCellVision: video.play() rejected', playErr);
        throw playErr;
      }

      cameraActive = true;
      hidePermScreen();
      setPermissionMessage('');
      setStatus('LIVE');
      video.addEventListener('loadedmetadata', onVideoReady, { once: true });
      video.addEventListener('canplay', () => {
        if (video.videoWidth && video.videoHeight) onVideoReady();
      }, { once: true });
      if (video.videoWidth && video.videoHeight) onVideoReady();
    } catch (err) {
      cameraActive = false;
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
      const state = await queryCameraPermission();
      if (state === 'denied') {
        updatePermissionUi('denied');
      } else {
        updatePermissionUi(state || 'prompt');
      }
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

  function ensureCanvasSize() {
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      console.log('ThermoCellVision: canvas resized to', { width, height });
    }
  }

  function paintRawCameraFrame() {
    if (!video || !video.videoWidth || !video.videoHeight) {
      return false;
    }

    ensureCanvasSize();
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      console.warn('ThermoCellVision: 2D canvas context unavailable');
      return false;
    }

    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return true;
    } catch (err) {
      console.warn('ThermoCellVision: drawImage failed during raw camera fallback:', err);
      return false;
    }
  }

  function onVideoReady() {
    console.log('ThermoCellVision: onVideoReady fired', { cameraActive, cvReady, videoWidth: video.videoWidth, videoHeight: video.videoHeight, readyState: video.readyState });
    if (!video.videoWidth || !video.videoHeight) {
      console.warn('ThermoCellVision: video dimensions missing; camera stream is active but not usable yet');
      setStatus('WAITING FOR CAMERA');
      return;
    }

    ensureCanvasSize();
    const width = video.videoWidth;
    const height = video.videoHeight;

    if (!cvReady || typeof cv === 'undefined' || !cv.Mat || !cv.VideoCapture || !cv.imshow) {
      console.warn('ThermoCellVision: OpenCV not ready yet; drawing raw camera feed while detection loads');
      setStatus('LOADING DETECTION');
      paintRawCameraFrame();
    } else {
      if (frameMat) { frameMat.delete(); frameMat = null; }
      frameMat = new cv.Mat(height, width, cv.CV_8UC4);
      cap = new cv.VideoCapture(video);

      if (!detector) detector = new HeatRegionDetector(320);

      console.log('ThermoCellVision: detector initialized and capture pipeline ready');
      setStatus('LIVE');
    }

    if (!running) {
      running = true;
      requestAnimationFrame(loop);
    }
  }

  function stopCamera() {
    console.log('ThermoCellVision: stopCamera called');
    running = false;
    cameraActive = false;

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

    try {
      if (cap && frameMat && detector && video.readyState >= 2 && video.videoWidth > 0) {
        if (!(paused && !scanRequested)) {
          const readOk = cap.read(frameMat);
          console.log('ThermoCellVision: cap.read()', { readOk, width: frameMat?.cols, height: frameMat?.rows, readyState: video.readyState });

          let result = null;
          try {
            if (scanRequested) detector.reset();
            result = detector.process(frameMat);
            scanRequested = false;

            if (!result || !result.frame) {
              console.warn('ThermoCellVision: detector.process() returned no result.frame; drawing raw feed fallback');
              paintRawCameraFrame();
            } else {
              console.log('ThermoCellVision: detector.process() produced overlay frame', {
                hotDetected: result.hotDetected,
                placementRecommended: result.placementRecommended,
                confidence: result.confidence,
                surfaceFound: result.surfaceFound,
                frameRows: result.frame.rows,
                frameCols: result.frame.cols
              });
              cv.imshow(canvas, result.frame);
              pushStats(result.hotDetected, result.placementRecommended, result.confidence);
            }
          } catch (err) {
            console.error('ThermoCellVision: CV frame processing failed:', err);
            paintRawCameraFrame();
            setStatus('ERROR');
            statusHot.textContent = 'DETECTION ERROR';
            statusPlace.textContent = 'PLACEMENT: PAUSED';
            if (scanRequested) scanRequested = false;
          } finally {
            if (result?.frame) {
              try { result.frame.delete(); } catch (_) {}
            }
          }
        }
      } else {
        const painted = paintRawCameraFrame();
        if (painted) {
          console.log('ThermoCellVision: raw camera feed rendered to canvas while OpenCV is loading or unavailable');
        }
      }
    } catch (outerErr) {
      console.error('ThermoCellVision: render loop failed:', outerErr);
      paintRawCameraFrame();
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
    console.log('ThermoCellVision: retry button clicked');
    const state = await queryCameraPermission();
    console.log('ThermoCellVision: retry button permission state', { state, cameraActive });

    if (state === 'denied') {
      updatePermissionUi('denied');
      return;
    }

    if (cameraActive && stream && video.srcObject) {
      console.log('ThermoCellVision: retry ignored because camera is already active');
      hidePermScreen();
      return;
    }

    await requestCamera({ forcePrompt: true });
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
      console.log('ThermoCellVision: visibilitychange camera resume check', { state, cameraActive, streamPresent: !!stream });
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

    detector = new HeatRegionDetector(320);
    sensVal.textContent = `${sensSlider.value}%`;
    opacVal.textContent = `${opacSlider.value}%`;

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
