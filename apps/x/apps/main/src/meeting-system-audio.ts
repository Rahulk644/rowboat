/**
 * Electron 39 uses Chromium's CoreAudio Tap implementation for system audio
 * on macOS 14.2+. That path does not need a screen source: keeping one in the
 * display-media response wrongly couples meeting audio to Screen Recording TCC.
 * Older macOS releases retain the conservative screen+loopback path.
 */
export type SystemAudioCaptureMode = 'audio-only-loopback' | 'screen-loopback';

export interface SystemAudioPlatform {
  platform: NodeJS.Platform;
  systemVersion?: string;
}

function parseVersionPart(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 0;
  return Number(value);
}

export function supportsMacOSCoreAudioTap(systemVersion: string | undefined): boolean {
  const [majorPart, minorPart] = (systemVersion ?? '').split('.', 3);
  const major = parseVersionPart(majorPart);
  const minor = parseVersionPart(minorPart);
  return major > 14 || (major === 14 && minor >= 2);
}

export function resolveSystemAudioCaptureMode({ platform, systemVersion }: SystemAudioPlatform): SystemAudioCaptureMode {
  return platform === 'darwin' && supportsMacOSCoreAudioTap(systemVersion)
    ? 'audio-only-loopback'
    : 'screen-loopback';
}

export interface DisplayMediaRequestShape {
  audioRequested: boolean;
  videoRequested: boolean;
  hasFrame: boolean;
}

/**
 * Electron 39 accepts the string loopback selector but not Electron 42's
 * `{ id: 'loopbackAllDevices' }` object. A requesting frame is supplied as a
 * throwaway video source for Electron's handler contract, while the renderer
 * requests audio only and never receives a screen track.
 */
export function shouldUseAudioOnlyLoopback(
  mode: SystemAudioCaptureMode,
  request: DisplayMediaRequestShape,
): boolean {
  return mode === 'audio-only-loopback'
    && request.audioRequested
    && !request.videoRequested
    && request.hasFrame;
}
