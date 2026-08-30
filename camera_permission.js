(function () {
  'use strict';

  function normalizePermissionState(state) {
    if (state === 'granted' || state === 'denied' || state === 'prompt') {
      return state;
    }
    return 'unknown';
  }

  function canRequestCamera({
    permissionState,
    forcePrompt = false,
    isEmbedded = false,
    isSecureContext = false,
    mediaDevicesSupported = false,
  } = {}) {
    const state = normalizePermissionState(permissionState);

    if (isEmbedded) {
      return { allowed: false, reason: 'embedded', state };
    }

    if (!isSecureContext) {
      return { allowed: false, reason: 'insecure', state };
    }

    if (!mediaDevicesSupported) {
      return { allowed: false, reason: 'missing-api', state };
    }

    if (state === 'denied' && !forcePrompt) {
      return { allowed: false, reason: 'denied', state };
    }

    return { allowed: true, reason: 'request', state };
  }

  function getPermissionRecoveryCopy() {
    return {
      denied: {
        title: 'Camera permission is blocked for this site.',
        help: 'Tap the lock or tune icon beside the address bar → Site settings → Camera → Allow, then return here and tap CHECK AGAIN. The app cannot change a browser-level denial itself.'
      },
      embedded: {
        title: 'This page is running inside an embedded preview.',
        help: 'Open the deployed HTTPS URL in a normal browser tab, then tap ALLOW CAMERA.'
      },
      insecure: {
        title: 'Camera access requires HTTPS.',
        help: 'Use the GitHub Pages HTTPS URL instead of an HTTP or preview URL.'
      }
    };
  }

  if (typeof window !== 'undefined') {
    window.CameraPermission = {
      normalizePermissionState,
      canRequestCamera,
      getPermissionRecoveryCopy,
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      normalizePermissionState,
      canRequestCamera,
      getPermissionRecoveryCopy,
    };
  }
})();
