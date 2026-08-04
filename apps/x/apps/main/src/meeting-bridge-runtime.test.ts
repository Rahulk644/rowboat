import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  createMeetingBridgeRuntime,
  resolveRowboatRepositoryRoot,
} from './meeting-bridge-runtime.js';
import type {
  BridgeEvent,
  MeetingBridgePaths,
  MeetingBridgeSupervisorOptions,
} from './meeting-bridge.js';

class FakeSupervisor {
  startCalls: string[] = [];
  stopCalls = 0;
  startFailure: Error | null = null;
  onStart: (() => void) | null = null;

  constructor(private readonly options: MeetingBridgeSupervisorOptions) {}

  async start(meetingId: string): Promise<boolean> {
    this.startCalls.push(meetingId);
    if (this.startFailure) throw this.startFailure;
    this.onStart?.();
    return true;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  emit(event: Exclude<BridgeEvent, { type: 'ready' } | { type: 'pong' }>): void {
    this.options.onEvent?.(event);
  }
}

function paths(): MeetingBridgePaths {
  return {
    repositoryRoot: path.resolve('/rowboat'),
    isPackaged: false,
    platform: 'darwin',
  };
}

test('bridge runtime starts after transcription, keeps a healthy bridge on restart, stops, and forwards only active speaker evidence', async () => {
  let supervisor: FakeSupervisor | undefined;
  const applied: Array<{
    meetingId: string;
    evidence: Array<{ source: string; displayName?: string; startSample: number; endSample: number }>;
  }> = [];
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
  });

  assert.equal(await runtime.begin('meeting-1'), true);
  assert.deepEqual(supervisor?.startCalls, ['meeting-1']);
  assert.equal(await runtime.restart('meeting-1'), true);
  assert.deepEqual(supervisor?.startCalls, ['meeting-1']);

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
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, [{
    meetingId: 'meeting-1',
    evidence: [{ source: 'zoom_ax', displayName: 'Akbar', startSample: 0, endSample: 320 }],
  }]);

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

  assert.equal(await runtime.begin('meeting-1'), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, ['Akbar']);
});

test('native bridge startup failure is silent and does not block the existing transcription lifecycle', async () => {
  let supervisor: FakeSupervisor | undefined;
  const runtime = createMeetingBridgeRuntime({
    paths,
    enabled: () => true,
    createSupervisor: (options) => {
      supervisor = new FakeSupervisor(options);
      supervisor.startFailure = new Error('native capture unavailable');
      return supervisor;
    },
    applySpeakerEvidence: () => {
      throw new Error('should not be called');
    },
  });

  assert.equal(await runtime.begin('meeting-1'), false);
  assert.deepEqual(supervisor?.startCalls, ['meeting-1']);
  supervisor!.startFailure = null;
  assert.equal(await runtime.restart('meeting-1'), true);
  assert.deepEqual(supervisor?.startCalls, ['meeting-1', 'meeting-1']);
  await runtime.stop('meeting-1');
  assert.equal(supervisor?.stopCalls, 1);
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

  assert.equal(await runtime.begin('meeting-1'), false);
  assert.equal(await runtime.restart('meeting-1'), false);
  await runtime.stop('meeting-1');
  assert.deepEqual(supervisor?.startCalls, []);
  assert.equal(supervisor?.stopCalls, 0);
});

test('repository root resolver uses the documented development app location', () => {
  assert.equal(
    resolveRowboatRepositoryRoot('/tmp/rowboat/apps/x/apps/main'),
    '/tmp/rowboat',
  );
  assert.throws(() => resolveRowboatRepositoryRoot('apps/x/apps/main'), /absolute/);
});
