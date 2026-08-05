import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  initializePackagedMeetingCapabilities,
  isMeetingBridgeEnabled,
  MeetingBridgeSupervisor,
  resolveMeetingBridgeBinary,
} from './meeting-bridge.js';

class FakeBridgeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly commands: Array<Record<string, string>> = [];
  killed = false;

  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (line: string) => {
      for (const command of line.trim().split('\n')) {
        if (command) this.commands.push(JSON.parse(command) as Record<string, string>);
      }
    });
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }

  emitReady(): void {
    this.stdout.write('{"type":"ready","protocol_version":1}\n');
  }

  close(): void {
    this.emit('close', 1, null);
  }

  kill(): boolean {
    this.killed = true;
    this.emit('close', 0, 'SIGTERM');
    return true;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('meeting bridge is disabled unless the explicit feature flag equals 1', () => {
  assert.equal(isMeetingBridgeEnabled({}), false);
  assert.equal(isMeetingBridgeEnabled({ ROWBOAT_MEETING_BRIDGE_ENABLED: 'true' }), false);
  assert.equal(isMeetingBridgeEnabled({ ROWBOAT_MEETING_BRIDGE_ENABLED: '1' }), true);
});

test('a packaged Rowboat enables only resources that are present in its sealed layout', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rowboat-packaged-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, 'Contents', 'Resources');
  const environment: NodeJS.ProcessEnv = { ROWBOAT_MEETING_BRIDGE_ENABLED: '1', ROWBOAT_MEETING_AEC_ENABLED: '1' };

  assert.deepEqual(initializePackagedMeetingCapabilities({
    repositoryRoot: root, resourcesPath: resources, isPackaged: true, platform: 'darwin',
  }, environment), { bridge: false, aec: false });
  assert.equal(environment.ROWBOAT_MEETING_BRIDGE_ENABLED, '0');
  assert.equal(environment.ROWBOAT_MEETING_AEC_ENABLED, '0');

  const bridgeDirectory = path.join(resources, 'meeting-bridge', 'darwin');
  fs.mkdirSync(bridgeDirectory, { recursive: true });
  const bridge = path.join(bridgeDirectory, 'meeting-bridge');
  fs.writeFileSync(bridge, 'bridge');
  fs.chmodSync(bridge, 0o755);
  delete environment.ROWBOAT_MEETING_BRIDGE_ENABLED;
  delete environment.ROWBOAT_MEETING_AEC_ENABLED;
  assert.deepEqual(initializePackagedMeetingCapabilities({
    repositoryRoot: root, resourcesPath: resources, isPackaged: true, platform: 'darwin',
  }, environment), { bridge: true, aec: false });

  const library = path.join(bridgeDirectory, 'liblocalvqe.0.1.0.dylib');
  const model = path.join(bridgeDirectory, 'localvqe-v1.4-aec-200K-f32.gguf');
  fs.writeFileSync(library, 'dylib');
  fs.writeFileSync(model, 'model');
  fs.chmodSync(library, 0o755);
  delete environment.ROWBOAT_MEETING_AEC_ENABLED;
  assert.deepEqual(initializePackagedMeetingCapabilities({
    repositoryRoot: root, resourcesPath: resources, isPackaged: true, platform: 'darwin',
  }, environment), { bridge: true, aec: true });
  assert.equal(environment.ROWBOAT_MEETING_AEC_ENGINE, 'local_vqe');
});

test('bridge binary resolver permits only expected packaged and dev locations', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rowboat-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const devDirectory = path.join(root, 'native', 'meeting-bridge', 'target', 'debug');
  fs.mkdirSync(devDirectory, { recursive: true });
  const devBinary = path.join(devDirectory, 'meeting-bridge');
  fs.writeFileSync(devBinary, 'bridge');
  fs.chmodSync(devBinary, 0o755);
  assert.equal(
    resolveMeetingBridgeBinary({ repositoryRoot: root, isPackaged: false, platform: 'darwin' }),
    fs.realpathSync.native(devBinary),
  );

  const resources = path.join(root, 'resources');
  const packagedDirectory = path.join(resources, 'meeting-bridge', 'darwin');
  fs.mkdirSync(packagedDirectory, { recursive: true });
  const packagedBinary = path.join(packagedDirectory, 'meeting-bridge');
  fs.writeFileSync(packagedBinary, 'bridge');
  fs.chmodSync(packagedBinary, 0o755);
  assert.equal(
    resolveMeetingBridgeBinary({ repositoryRoot: root, resourcesPath: resources, isPackaged: true, platform: 'darwin' }),
    fs.realpathSync.native(packagedBinary),
  );

  assert.throws(
    () => resolveMeetingBridgeBinary({ repositoryRoot: 'relative-root', isPackaged: false, platform: 'darwin' }),
    /absolute path/,
  );
});

test('main supervisor uses private stdio, completes handshake, and exposes metadata only', async (t) => {
  const originalToken = process.env.ROWBOAT_MEETING_STT_TOKEN;
  const originalLibrary = process.env.ROWBOAT_MEETING_AEC_LOCALVQE_LIBRARY;
  const originalModel = process.env.ROWBOAT_MEETING_AEC_LOCALVQE_MODEL;
  process.env.ROWBOAT_MEETING_STT_TOKEN = 'must-not-reach-the-native-child';
  process.env.ROWBOAT_MEETING_AEC_LOCALVQE_LIBRARY = '/untrusted/localvqe.dylib';
  process.env.ROWBOAT_MEETING_AEC_LOCALVQE_MODEL = '/untrusted/localvqe.gguf';
  t.after(() => {
    if (originalToken === undefined) delete process.env.ROWBOAT_MEETING_STT_TOKEN;
    else process.env.ROWBOAT_MEETING_STT_TOKEN = originalToken;
    if (originalLibrary === undefined) delete process.env.ROWBOAT_MEETING_AEC_LOCALVQE_LIBRARY;
    else process.env.ROWBOAT_MEETING_AEC_LOCALVQE_LIBRARY = originalLibrary;
    if (originalModel === undefined) delete process.env.ROWBOAT_MEETING_AEC_LOCALVQE_MODEL;
    else process.env.ROWBOAT_MEETING_AEC_LOCALVQE_MODEL = originalModel;
  });

  const child = new FakeBridgeChild();
  const events: unknown[] = [];
  let spawnCall: { executable: string; args: readonly string[]; options: Record<string, unknown> } | undefined;
  const supervisor = new MeetingBridgeSupervisor({
    enabled: () => true,
    resolveBinary: () => '/approved/meeting-bridge',
    spawn: (executable, args, options) => {
      spawnCall = { executable, args, options: options as unknown as Record<string, unknown> };
      return child.asChild();
    },
    onEvent: (event) => events.push(event),
  });

  const start = supervisor.start('meeting A');
  child.emitReady();
  assert.equal(await start, true);
  assert.deepEqual(child.commands, [{ type: 'start', meeting_id: 'meeting-A' }]);
  assert.equal(spawnCall?.executable, '/approved/meeting-bridge');
  assert.deepEqual(spawnCall?.args, []);
  assert.equal(spawnCall?.options.shell, false);
  assert.equal(spawnCall?.options.stdio, 'pipe');
  assert.equal((spawnCall?.options.env as NodeJS.ProcessEnv).ROWBOAT_MEETING_STT_TOKEN, undefined);
  assert.equal((spawnCall?.options.env as NodeJS.ProcessEnv).ROWBOAT_MEETING_AEC_LOCALVQE_LIBRARY, undefined);
  assert.equal((spawnCall?.options.env as NodeJS.ProcessEnv).ROWBOAT_MEETING_AEC_LOCALVQE_MODEL, undefined);

  const ping = supervisor.ping();
  const pingCommand = child.commands.at(-1) as Record<string, string>;
  assert.equal(pingCommand.type, 'ping');
  const requestId = pingCommand.request_id;
  assert.ok(requestId);
  child.stdout.write(`${JSON.stringify({ type: 'pong', request_id: requestId })}\n`);
  await ping;

  child.stdout.write(`${JSON.stringify({
    type: 'audio_frame',
    metadata: {
      meeting_id: 'meeting-A', source_id: 'system', channel: 'system', start_sample: 0,
      sample_count: 320, sample_rate: 16_000, sequence: 0, epoch: 0,
      flags: { discontinuity: false, recovered: false, silence: true },
    },
  })}\n`);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: 'audio_frame',
    metadata: {
      meeting_id: 'meeting-A', source_id: 'system', channel: 'system', start_sample: 0,
      sample_count: 320, sample_rate: 16_000, sequence: 0, epoch: 0,
      flags: { discontinuity: false, recovered: false, silence: true },
    },
  });
  child.stdout.write(`${JSON.stringify({
    type: 'speaker_evidence',
    evidence: {
      meeting_id: 'meeting-A', start_sample: 0, end_sample: 320, platform: 'zoom', surface: 'native',
      participant_id: 'participant-1', display_name: 'Akbar', is_self: false, is_active: true, is_muted: false,
      source: 'zoom_ax', confidence: 0.9, observed_at_sample: 320, signals: ['active_speaker_label'],
    },
  })}\n`);
  assert.deepEqual(events[1], {
    type: 'speaker_evidence',
    evidence: {
      meetingId: 'meeting-A', startSample: 0, endSample: 320, platform: 'zoom', surface: 'native',
      participantId: 'participant-1', displayName: 'Akbar', isSelf: false, isActive: true, isMuted: false,
      source: 'zoom_ax', confidence: 0.9, observedAtSample: 320, signals: ['active_speaker_label'],
    },
  });
  const manySmallEvents = Array.from(
    { length: 2_100 },
    () => '{"type":"pong","request_id":"unused"}\n',
  ).join('');
  assert.ok(Buffer.byteLength(manySmallEvents) > 64 * 1024);
  child.stdout.write(manySmallEvents);
  assert.equal(child.killed, false, 'a chunk with many valid small events is not treated as one oversized event');
  assert.equal(supervisor.getStatus().state, 'ready');
  await supervisor.stop();
});

test('warm handshakes without Start and startIfReady never cold-spawns', async () => {
  const child = new FakeBridgeChild();
  let spawnCount = 0;
  const supervisor = new MeetingBridgeSupervisor({
    enabled: () => true,
    resolveBinary: () => '/approved/meeting-bridge',
    spawn: () => {
      spawnCount += 1;
      return child.asChild();
    },
  });

  const warming = supervisor.warm();
  child.emitReady();
  assert.equal(await warming, true);
  assert.deepEqual(child.commands, []);
  assert.equal(await supervisor.startIfReady('meeting A'), true);
  assert.deepEqual(child.commands, [{ type: 'start', meeting_id: 'meeting-A' }]);

  const cold = new MeetingBridgeSupervisor({
    enabled: () => true,
    resolveBinary: () => '/approved/meeting-bridge',
    spawn: () => {
      spawnCount += 1;
      return child.asChild();
    },
  });
  assert.equal(await cold.startIfReady('meeting B'), false);
  assert.equal(spawnCount, 1);
});

test('AEC route update keeps the ready child and uses the private result lane', async (t) => {
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
  const child = new FakeBridgeChild();
  const supervisor = new MeetingBridgeSupervisor({
    enabled: () => true,
    resolveBinary: () => '/approved/meeting-bridge',
    spawn: () => child.asChild(),
  });
  const started = supervisor.start('meeting');
  child.emitReady();
  assert.equal(await started, true);
  assert.equal(child.commands.length, 1);
  assert.deepEqual(child.commands[0], {
    type: 'start', meeting_id: 'meeting', aec_output_route: 'speaker',
  });

  const update = supervisor.updateAecOutputRoute('meeting', true);
  const route = child.commands.at(-1) as Record<string, string>;
  assert.equal(route.type, 'aec_route_update');
  assert.equal(route.meeting_id, 'meeting');
  assert.equal(route.aec_output_route, 'isolated');
  assert.ok(route.request_id);
  child.stdout.write(`${JSON.stringify({
    type: 'aec_result', request_id: route.request_id, meeting_id: 'meeting', frames: [],
  })}\n`);
  assert.deepEqual(await update, { meetingId: 'meeting', frames: [] });
  assert.equal(child.killed, false);
  assert.equal(child.commands.filter((command) => command.type === 'start').length, 1);
  await supervisor.stop();
});

test('malformed or PCM-bearing events are rejected and a closed bridge is recycled with bounded backoff', async (t) => {
  const children: FakeBridgeChild[] = [];
  const supervisor = new MeetingBridgeSupervisor({
    enabled: () => true,
    resolveBinary: () => '/approved/meeting-bridge',
    spawn: () => {
      const child = new FakeBridgeChild();
      children.push(child);
      return child.asChild();
    },
    restartBackoff: { initialMs: 1, maximumMs: 2, maximumRestarts: 2, windowMs: 100 },
  });
  t.after(async () => supervisor.stop());

  const start = supervisor.start('meeting');
  children[0].emitReady();
  await start;
  children[0].stdout.write(`${JSON.stringify({
    type: 'audio_frame',
    metadata: {
      meeting_id: 'meeting', source_id: 'mic', channel: 'mic', start_sample: 0,
      sample_count: 320, sample_rate: 16_000, sequence: 0, epoch: 0,
      flags: { discontinuity: false, recovered: false, silence: false },
      pcm_s16le: 'forbidden',
    },
  })}\n`);
  await delay(10);
  assert.equal(children.length, 2, 'bad event should recycle rather than reach a renderer');
  assert.equal(children[0].killed, true, 'failed bridge process is terminated before replacement');
  children[1].emitReady();
  await delay(1);
  children[1].close();
  await delay(10);
  assert.equal(children.length, 3, 'unexpected close should recycle the desired bridge');
  children[2].emitReady();
  await delay(1);
  children[2].close();
  await delay(10);
  assert.equal(supervisor.getStatus().state, 'failed', 'restart count is bounded');
});

test('a stalled capture source gets one bounded recovery window before the helper is recreated', async (t) => {
  const children: FakeBridgeChild[] = [];
  const supervisor = new MeetingBridgeSupervisor({
    enabled: () => true,
    resolveBinary: () => '/approved/meeting-bridge',
    spawn: () => {
      const child = new FakeBridgeChild();
      children.push(child);
      return child.asChild();
    },
    restartBackoff: { initialMs: 1, maximumMs: 1, maximumRestarts: 1, windowMs: 100 },
    captureRecoveryTimeoutMs: 2,
  });
  t.after(async () => supervisor.stop());

  const started = supervisor.start('meeting');
  children[0]!.emitReady();
  await started;
  children[0]!.stdout.write(`${JSON.stringify({
    type: 'capture_health',
    health: {
      meeting_id: 'meeting', channel: 'system', state: 'stalled', sequence: 10,
      last_frame_sample: 3_200, restart_count: 0, reason: 'source stopped producing frames',
    },
  })}\n`);
  await delay(20);
  assert.equal(children[0]!.killed, true);
  assert.equal(children.length, 2, 'a stalled source should recreate the helper after its grace deadline');
  children[1]!.emitReady();
  await delay(1);
  assert.deepEqual(children[1]!.commands, [{ type: 'start', meeting_id: 'meeting' }]);
});
