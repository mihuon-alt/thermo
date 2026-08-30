const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePermissionState, canRequestCamera } = require('../camera_permission.js');

test('normalizePermissionState accepts browser permission states', () => {
  assert.equal(normalizePermissionState('granted'), 'granted');
  assert.equal(normalizePermissionState('denied'), 'denied');
  assert.equal(normalizePermissionState('prompt'), 'prompt');
  assert.equal(normalizePermissionState('unknown'), 'unknown');
  assert.equal(normalizePermissionState(undefined), 'unknown');
});

test('denied permission blocks a silent request but allows an explicit retry', () => {
  const blocked = canRequestCamera({
    permissionState: 'denied',
    forcePrompt: false,
    isEmbedded: false,
    isSecureContext: true,
    mediaDevicesSupported: true,
  });

  const allowed = canRequestCamera({
    permissionState: 'denied',
    forcePrompt: true,
    isEmbedded: false,
    isSecureContext: true,
    mediaDevicesSupported: true,
  });

  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'denied');
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, 'request');
});

test('embedded and insecure pages are blocked before getUserMedia is even attempted', () => {
  const embedded = canRequestCamera({
    permissionState: 'prompt',
    forcePrompt: true,
    isEmbedded: true,
    isSecureContext: true,
    mediaDevicesSupported: true,
  });

  const insecure = canRequestCamera({
    permissionState: 'prompt',
    forcePrompt: true,
    isEmbedded: false,
    isSecureContext: false,
    mediaDevicesSupported: true,
  });

  assert.equal(embedded.allowed, false);
  assert.equal(embedded.reason, 'embedded');
  assert.equal(insecure.allowed, false);
  assert.equal(insecure.reason, 'insecure');
});
