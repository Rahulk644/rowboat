import { describe, expect, it } from 'vitest';
import { MeetingCaptureWatchdog } from './meeting-capture-watchdog';

describe('MeetingCaptureWatchdog', () => {
  it('does not mistake a quiet but live system track for a dropout', () => {
    const watchdog = new MeetingCaptureWatchdog(() => 1_000, 500);
    expect(watchdog.endedChannels({
      mic: { readyState: 'live', muted: false },
      system: { readyState: 'live', muted: true },
    })).toEqual([]);
    expect(watchdog.onDeviceChange({
      mic: { readyState: 'live', muted: false },
      system: { readyState: 'live', muted: true },
    })).toEqual([]);
  });

  it('requests only the affected source when a track actually ends', () => {
    const watchdog = new MeetingCaptureWatchdog();
    expect(watchdog.endedChannels({
      mic: { readyState: 'live', muted: false },
      system: { readyState: 'ended', muted: false },
    })).toEqual(['system']);
  });

  it('uses audio callback absence, never silence, for a graph-wide recovery request', () => {
    let now = 0;
    const watchdog = new MeetingCaptureWatchdog(() => now, 1_000);
    watchdog.recordAudioCallback();
    now = 1_001;
    expect(watchdog.stalledChannels('running')).toEqual(['mic', 'system']);
    expect(watchdog.stalledChannels('running')).toEqual([]);
    watchdog.recordAudioCallback();
    now += 2_000;
    expect(watchdog.stalledChannels('suspended')).toEqual([]);
  });

  it('re-arms only a bounded number of graph recovery attempts until a real callback arrives', () => {
    let now = 0;
    const watchdog = new MeetingCaptureWatchdog(() => now, 100, 2);
    now = 101;
    expect(watchdog.stalledChannels('running')).toEqual(['mic', 'system']);
    expect(watchdog.rearmAfterStall()).toBe(true);

    now += 101;
    expect(watchdog.stalledChannels('running')).toEqual(['mic', 'system']);
    expect(watchdog.rearmAfterStall()).toBe(true);

    now += 101;
    expect(watchdog.stalledChannels('running')).toEqual(['mic', 'system']);
    expect(watchdog.rearmAfterStall()).toBe(false);

    watchdog.recordAudioCallback();
    now += 101;
    expect(watchdog.stalledChannels('running')).toEqual(['mic', 'system']);
    expect(watchdog.rearmAfterStall()).toBe(true);
  });
});
