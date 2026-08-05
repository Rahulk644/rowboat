import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveSystemAudioCaptureMode,
  shouldUseAudioOnlyLoopback,
  supportsMacOSCoreAudioTap,
} from './meeting-system-audio.js';

test('CoreAudio Tap audio-only loopback is limited to macOS 14.2 and newer', () => {
  assert.equal(supportsMacOSCoreAudioTap('14.1.9'), false);
  assert.equal(supportsMacOSCoreAudioTap('14.2.0'), true);
  assert.equal(supportsMacOSCoreAudioTap('15.0.0'), true);
  assert.equal(supportsMacOSCoreAudioTap('26.0.0'), true);
  assert.equal(supportsMacOSCoreAudioTap('not-a-version'), false);
  assert.equal(resolveSystemAudioCaptureMode({ platform: 'darwin', systemVersion: '14.2.0' }), 'audio-only-loopback');
  assert.equal(resolveSystemAudioCaptureMode({ platform: 'darwin', systemVersion: '14.1.9' }), 'screen-loopback');
  assert.equal(resolveSystemAudioCaptureMode({ platform: 'win32', systemVersion: '99.0.0' }), 'screen-loopback');
});

test('audio-only loopback never changes a video request or a destroyed frame', () => {
  assert.equal(shouldUseAudioOnlyLoopback('audio-only-loopback', {
    audioRequested: true,
    videoRequested: false,
    hasFrame: true,
  }), true);
  assert.equal(shouldUseAudioOnlyLoopback('audio-only-loopback', {
    audioRequested: true,
    videoRequested: true,
    hasFrame: true,
  }), false);
  assert.equal(shouldUseAudioOnlyLoopback('audio-only-loopback', {
    audioRequested: true,
    videoRequested: false,
    hasFrame: false,
  }), false);
  assert.equal(shouldUseAudioOnlyLoopback('screen-loopback', {
    audioRequested: true,
    videoRequested: false,
    hasFrame: true,
  }), false);
});
