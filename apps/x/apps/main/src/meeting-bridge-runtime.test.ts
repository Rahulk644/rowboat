import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  createMeetingBridgeRuntime,
  resolveRowboatRepositoryRoot,
} from './meeting-bridge-runtime.js';
import type {
  BridgeAecResult,
  BridgeEvent,
  MeetingBridgePaths,
  MeetingBridgeStatus,
  MeetingBridgeSupervisorOptions,
} from './meeting-bridge.js';

class FakeSupervisor {
  warmCalls = 0;
  startIfReadyCalls: string[] = [];
  updateAecOutputRouteCalls: Array<{ meetingId: string; isolated: boolean }> = [];
  stopCalls = 0;
  stopped = false;
  warmFailure: Error | null = null;
  warmResult: Promise<boolean> | null = null;
  startIfReadyFailure: Error | null = null;
  onStart: (() => void) | null = null;

  constructor(private readonly options: MeetingBridgeSupervisorOptions) {}

  async warm(): Promise<boolean> {
    this.warmCalls += 1;
    if (this.stopped) throw new Error('warm invoked after stop');
    if (this.warmFailure) throw this.warmFailure;
    return this.warmResult ?? true;
  }

  async startIfReady(meetingId: string): Promise<boolean> {
    this.startIfReadyCalls.push(meetingId);
    if (this.startIfReadyFailure) throw this.startIfReadyFailure;
    this.onStart?.();
    return true;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.stopped = true;
  }

  async processAecFrame(): Promise<BridgeAecResult | null> {
    return null;
  }

  async flushAec(): Promise<BridgeAecResult | null> {
    return null;
  }

  async updateAecOutputRoute(meetingId: string, isolated: boolean): Promise<BridgeAecResult | null> {
    this.updateAecOutputRouteCalls.push({ meetingId, isolated });
    return null;
  }

  maximumRestarts(): number | undefined {
    return this.options.restartBackoff?.maximumRestarts;
  }

  emit(event: Exclude<BridgeEvent, { type: 'ready' } | { type: 'pong' }>): void {
    this.options.onEvent?.(event);
  }

  emitStatus(status: MeetingBridgeStatus): void {
    this.options.onStatus?.(status);
  }
}

function paths(): MeetingBridgePaths {
  return {
    repositoryRoot: path.resolve('/rowboat'),
    isPackaged: false,
    platform: 'darwin',
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test('bridge runtime warms before capture, starts only when ready, keeps a healthy bridge on restart, and forwards only active speaker evidence', async () => {
  let supervisor: FakeSupervisor | undefined;
  const applied: Array<{
    meetingId: string;
    evidence: Array<{ source: string; displayName?: string; startSample: number; endSample: number }>;
  }> = [];
  const lifecycle: Array<{ meetingId: string; state: string }> = [];
  const runtime = createMeetingBridgeRuntime({
    paths,
    enabled: () => true,
    createSupervisor: (options) => {
      supervisor = new FakeSupervisor(options);
      return supervisor;
    },
    applySpeakerEvidence: async (meetingId, evidence) => {
      applied.push({
        meetingId,
        evidence: evidence.map(({ source, displayName, startSample, endSample }) => (
          { source, displayName, startSample, endSample }
        )),
      });
    },
    onMeetingLifecycle: (meetingId, state) => {
      lifecycle.push({ meetingId, state });
    },
  });

  assert.equal(await runtime.warm('meeting-1'), true);
  assert.equal(supervisor?.warmCalls, 1);
  assert.equal(supervisor?.maximumRestarts(), 3);
  assert.equal(await runtime.captureReady('meeting-1'), true);
  assert.deepEqual(supervisor?.startIfReadyCalls, ['meeting-1']);
  assert.equal(await runtime.restart('meeting-1'), true);
  assert.deepEqual(supervisor?.startIfReadyCalls, ['meeting-1']);

  supervisor?.emit({
    type: 'audio_frame',
    metadata: {
      meeting_id: 'meeting-1', source_id: 'system', channel: 'system', start_sample: 0,
      sample_count: 320, sample_rate: 16_000, sequence: 0, epoch: 0,
      flags: { discontinuity: false, recovered: false, silence: false },
    },
  });
  supervisor?.emit({
    type: 'speaker_evidence',
    evidence: {
      meetingId: 'meeting-1', startSample: 0, endSample: 320, platform: 'zoom', surface: 'native',
      participantId: 'p1', displayName: 'Akbar', isSelf: false, isActive: true, isMuted: false,
      source: 'zoom_ax', confidence: 0.9, observedAtSample: 320, signals: ['active_speaker_label'],
    },
  });
  supervisor?.emit({
    type: 'speaker_evidence',
    evidence: {
      meetingId: 'another-meeting', startSample: 0, endSample: 320, platform: 'zoom', surface: 'native',
      source: 'zoom_ax', confidence: 0.9, observedAtSample: 320, signals: [],
    },
  });
  supervisor?.emit({ type: 'meeting_lifecycle', meeting_id: 'meeting-1', state: 'active' });
  supervisor?.emit({ type: 'meeting_lifecycle', meeting_id: 'another-meeting', state: 'ended' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, [{
    meetingId: 'meeting-1',
    evidence: [{ source: 'zoom_ax', displayName: 'Akbar', startSample: 0, endSample: 320 }],
  }]);
  assert.deepEqual(lifecycle, [{ meetingId: 'meeting-1', state: 'active' }]);

  await runtime.stop('meeting-1');
  assert.equal(supervisor?.stopCalls, 1);
  supervisor?.emit({
    type: 'speaker_evidence',
    evidence: {
      meetingId: 'meeting-1', startSample: 0, endSample: 320, platform: 'zoom', surface: 'native',
      source: 'zoom_ax', confidence: 0.9, observedAtSample: 320, signals: [],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(applied.length, 1);
});

test('speaker evidence emitted during native Start is not lost before start resolves', async () => {
  let supervisor: FakeSupervisor | undefined;
  const applied: string[] = [];
  const runtime = createMeetingBridgeRuntime({
    paths,
    enabled: () => true,
    createSupervisor: (options) => {
      supervisor = new FakeSupervisor(options);
      supervisor.onStart = () => {
        supervisor?.emit({
          type: 'speaker_evidence',
          evidence: {
            meetingId: 'meeting-1', startSample: 0, endSample: 3_200, platform: 'zoom', surface: 'native',
            participantId: 'akbar', displayName: 'Akbar', isActive: true,
            source: 'zoom_ax', confidence: 0.9, observedAtSample: 3_200, signals: ['active_speaker_label'],
          },
        });
      };
      return supervisor;
    },
    applySpeakerEvidence: async (_meetingId, evidence) => {
      applied.push(evidence[0]?.displayName ?? 'missing');
    },
  });

  assert.equal(await runtime.warm('meeting-1'), true);
  assert.equal(await runtime.captureReady('meeting-1'), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, ['Akbar']);
});

test('repeated captureReady preserves one helper session and route update never restarts evidence', async (t) => {
  const originalBridge = process.env.ROWBOAT_MEETING_BRIDGE_ENABLED;
  const originalAec = process.env.ROWBOAT_MEETING_AEC_ENABLED;
  process.env.ROWBOAT_MEETING_BRIDGE_ENABLED = '1';
  process.env.ROWBOAT_MEETING_AEC_ENABLED = '1';
  t.after(() => {
    if (originalBridge === undefined) delete process.env.ROWBOAT_MEETING_BRIDGE_ENABLED;
    else process.env.ROWBOAT_MEETING_BRIDGE_ENABLED = originalBridge;
    if (originalAec === undefined) delete process.env.ROWBOAT_MEETING_AEC_ENABLED;
    else process.env.ROWBOAT_MEETING_AEC_ENABLED = originalAec;
  });

  let supervisor: FakeSupervisor | undefined;
  const runtime = createMeetingBridgeRuntime({
    paths,
    enabled: () => true,
    createSupervisor: (options) => {
      supervisor = new FakeSupervisor(options);
      return supervisor;
    },
    applySpeakerEvidence: () => {},
  });

  assert.equal(await runtime.warm('meeting-1'), true);
  assert.equal(await runtime.captureReady('meeting-1', false), true);
  assert.equal(await runtime.captureReady('meeting-1', true), true);
  assert.deepEqual(supervisor?.startIfReadyCalls, ['meeting-1']);

  assert.equal(await runtime.updateAecOutputRoute('meeting-1', true), null);
  assert.deepEqual(supervisor?.updateAecOutputRouteCalls, [{ meetingId: 'meeting-1', isolated: true }]);
  assert.deepEqual(supervisor?.startIfReadyCalls, ['meeting-1']);
});

test('native warmup failure is silent and captureReady never cold-starts a late helper', async () => {
  let supervisor: FakeSupervisor | undefined;
  const runtime = createMeetingBridgeRuntime({
    paths,
    enabled: () => true,
    createSupervisor: (options) => {
      supervisor = new FakeSupervisor(options);
      supervisor.warmFailure = new Error('native capture unavailable');
      return supervisor;
    },
    applySpeakerEvidence: () => {
      throw new Error('should not be called');
    },
  });

  assert.equal(await runtime.warm('meeting-1'), false);
  assert.equal(await runtime.captureReady('meeting-1'), false);
  assert.deepEqual(supervisor?.startIfReadyCalls, []);
  supervisor!.warmFailure = null;
  assert.equal(await runtime.warm('meeting-1'), true);
  assert.equal(await runtime.captureReady('meeting-1'), true);
  assert.deepEqual(supervisor?.startIfReadyCalls, ['meeting-1']);
  await runtime.stop('meeting-1');
  assert.equal(supervisor?.stopCalls, 1);
});

test('captureReady awaits the already-started warmup and starts exactly once', async () => {
  let supervisor: FakeSupervisor | undefined;
  const gate = deferred<boolean>();
  const runtime = createMeetingBridgeRuntime({
    paths,
    enabled: () => true,
    createSupervisor: (options) => {
      supervisor = new FakeSupervisor(options);
      supervisor.warmResult = gate.promise;
      return supervisor;
    },
    applySpeakerEvidence: () => {},
  });

  const warming = runtime.warm('meeting-1');
  const ready = runtime.captureReady('meeting-1');
  assert.deepEqual(supervisor?.startIfReadyCalls, []);
  gate.resolve(true);
  assert.equal(await warming, true);
  assert.equal(await ready, true);
  assert.deepEqual(supervisor?.startIfReadyCalls, ['meeting-1']);
});

test('reset cancels an unresolved warmup so it cannot revive a bridge later', async () => {
  let supervisor: FakeSupervisor | undefined;
  const gate = deferred<boolean>();
  const runtime = createMeetingBridgeRuntime({
    paths,
    enabled: () => true,
    createSupervisor: (options) => {
      supervisor = new FakeSupervisor(options);
      supervisor.warmResult = gate.promise;
      return supervisor;
    },
    applySpeakerEvidence: () => {},
  });

  const warming = runtime.warm('meeting-1');
  assert.equal(supervisor?.warmCalls, 1);
  await runtime.stop('meeting-1');
  gate.resolve(true);
  assert.equal(await warming, false);
  assert.equal(await runtime.captureReady('meeting-1'), false);
  assert.equal(supervisor?.stopCalls, 1);
  assert.equal(supervisor?.warmCalls, 1);
  assert.deepEqual(supervisor?.startIfReadyCalls, []);
});

test('reset cleanup stops a warmed helper even when capture never became ready', async () => {
  let supervisor: FakeSupervisor | undefined;
  const runtime = createMeetingBridgeRuntime({
    paths,
    enabled: () => true,
    createSupervisor: (options) => {
      supervisor = new FakeSupervisor(options);
      return supervisor;
    },
    applySpeakerEvidence: () => {},
  });

  assert.equal(await runtime.warm('meeting-1'), true);
  await runtime.stop('meeting-1');
  assert.equal(supervisor?.stopCalls, 1);
});

test('helper recovery keeps the process bounded but quarantines the new evidence clock', async () => {
  let supervisor: FakeSupervisor | undefined;
  const applied: string[] = [];
  const runtime = createMeetingBridgeRuntime({
    paths,
    enabled: () => true,
    createSupervisor: (options) => {
      supervisor = new FakeSupervisor(options);
      return supervisor;
    },
    applySpeakerEvidence: (_meetingId, evidence) => {
      applied.push(evidence[0]?.displayName ?? 'missing');
    },
  });

  await runtime.warm('meeting-1');
  await runtime.captureReady('meeting-1');
  supervisor?.emitStatus({ state: 'recovering', restartCount: 1, reason: 'system capture stalled' });
  supervisor?.emit({
    type: 'speaker_evidence',
    evidence: {
      meetingId: 'meeting-1', startSample: 0, endSample: 3_200, platform: 'zoom', surface: 'native',
      participantId: 'akbar', displayName: 'Akbar', isActive: true,
      source: 'zoom_ax', confidence: 0.9, observedAtSample: 3_200, signals: ['active_speaker_label'],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, [], 'a restarted helper must not relabel an old sample clock');

  await runtime.dispose();
  assert.equal(supervisor?.stopCalls, 1);
  assert.equal(await runtime.captureReady('meeting-1'), false);
});

test('disabled bridge never starts a native helper', async () => {
  let supervisor: FakeSupervisor | undefined;
  const runtime = createMeetingBridgeRuntime({
    paths,
    enabled: () => false,
    createSupervisor: (options) => {
      supervisor = new FakeSupervisor(options);
      return supervisor;
    },
    applySpeakerEvidence: () => {},
  });

  assert.equal(await runtime.warm('meeting-1'), false);
  assert.equal(await runtime.captureReady('meeting-1'), false);
  assert.equal(await runtime.restart('meeting-1'), false);
  await runtime.stop('meeting-1');
  assert.equal(supervisor?.warmCalls, 0);
  assert.deepEqual(supervisor?.startIfReadyCalls, []);
  assert.equal(supervisor?.stopCalls, 0);
});

test('repository root resolver uses the documented development app location', () => {
  assert.equal(
    resolveRowboatRepositoryRoot('/tmp/rowboat/apps/x/apps/main'),
    '/tmp/rowboat',
  );
  assert.throws(() => resolveRowboatRepositoryRoot('apps/x/apps/main'), /absolute/);
});
