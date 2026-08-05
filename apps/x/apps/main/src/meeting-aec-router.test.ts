import assert from 'node:assert/strict';
import test from 'node:test';

import { AecAsrDeliveryQueue, MeetingAecRouter, type AecBridgeTransport, type AecMicBatch } from './meeting-aec-router.js';
import type { BridgeAecInputFrame, BridgeAecOutputFrame } from './meeting-bridge.js';
import type { MeetingAudioFeedFlag } from './meeting-transcription.js';

function pcm(samples: number, value: number): string {
  const bytes = Buffer.alloc(samples * 2);
  for (let offset = 0; offset < bytes.length; offset += 2) bytes.writeInt16LE(value, offset);
  return bytes.toString('base64');
}

function output(frame: BridgeAecInputFrame): BridgeAecOutputFrame {
  return {
    ...frame,
    aec: {
      engine: 'local_vqe',
      disposition: 'cleaned',
      referenceTiming: 'trusted',
      referenceOffsetSamples: 0,
    },
  };
}

function metadata(startSample: number, sequence: number) {
  return { startSample, sampleCount: 640, sampleRate: 16_000, sequence, flags: [] as MeetingAudioFeedFlag[] };
}

test('AEC router returns complete ordered batches only after helper frame acknowledgements', async () => {
  const calls: Array<{ mic: BridgeAecInputFrame; render: BridgeAecInputFrame }> = [];
  const transport: AecBridgeTransport = {
    async processAecFrame(_meetingId, mic, render) {
      calls.push({ mic, render });
      return { meetingId: 'm', frames: [output(mic)] };
    },
    async flushAec() { return { meetingId: 'm', frames: [] }; },
    async updateAecOutputRoute() { return { meetingId: 'm', frames: [] }; },
  };
  const router = new MeetingAecRouter();
  const result = await router.processPair(transport, 'm', pcm(640, 17), pcm(640, 3), metadata(0, 0), metadata(0, 0));

  assert.equal(result.active, true);
  assert.equal(result.failedOpen, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.mic.startSample, 0);
  assert.equal(calls[1]?.mic.startSample, 320);
  assert.deepEqual(result.mic, [{ pcmBase64: pcm(640, 17), metadata: { ...metadata(0, 0), sourceId: 'm.mic' } }]);
});

test('AEC router tolerates a reblocker that delays frames and flushes a raw tail without reordering', async () => {
  let held: BridgeAecInputFrame | null = null;
  const transport: AecBridgeTransport = {
    async processAecFrame(_meetingId, mic) {
      const frames = held ? [output(held)] : [];
      held = mic;
      return { meetingId: 'm', frames };
    },
    async flushAec() {
      const frames = held ? [output(held)] : [];
      held = null;
      return { meetingId: 'm', frames };
    },
    async updateAecOutputRoute() { return { meetingId: 'm', frames: [] }; },
  };
  const router = new MeetingAecRouter();
  const first = await router.processPair(transport, 'm', pcm(640, 9), pcm(640, 1), metadata(0, 0), metadata(0, 0));
  assert.deepEqual(first.mic, []);

  const second = await router.processPair(transport, 'm', pcm(640, 11), pcm(640, 2), metadata(640, 1), metadata(640, 1));
  assert.equal(second.mic.length, 1);
  assert.equal(second.mic[0]?.pcmBase64, pcm(640, 9));
  assert.equal(second.mic[0]?.metadata.startSample, 0);

  const tail = await router.flush(transport, 'm');
  assert.equal(tail.length, 1);
  assert.equal(tail[0]?.pcmBase64, pcm(640, 11));
  assert.equal(tail[0]?.metadata.startSample, 640);
});

test('AEC route update releases the held tail once, then repeated devicechange is a no-op', async () => {
  let held: BridgeAecInputFrame | null = null;
  const routeUpdates: boolean[] = [];
  const transport: AecBridgeTransport = {
    async processAecFrame(_meetingId, mic) {
      held = mic;
      return { meetingId: 'm', frames: [] };
    },
    async flushAec() { return { meetingId: 'm', frames: [] }; },
    async updateAecOutputRoute(_meetingId, isolated) {
      routeUpdates.push(isolated);
      const frames = held ? [output(held)] : [];
      held = null;
      return { meetingId: 'm', frames };
    },
  };
  const router = new MeetingAecRouter();
  const original = pcm(320, 13);
  const frameMetadata = { ...metadata(0, 0), sampleCount: 320 };
  const first = await router.processPair(transport, 'm', original, pcm(320, 3), frameMetadata, frameMetadata);
  assert.deepEqual(first.mic, []);

  // The initial Start already carries `speaker`; only a real route change is
  // sent, and its raw-safe returned tail goes through the same ASR router.
  const switched = await router.updateOutputRoute(transport, 'm', true);
  assert.deepEqual(routeUpdates, [true]);
  assert.deepEqual(switched, [{ pcmBase64: original, metadata: { ...frameMetadata, sourceId: 'm.mic' } }]);
  assert.deepEqual(await router.updateOutputRoute(transport, 'm', true), []);
  assert.deepEqual(routeUpdates, [true]);
});

test('AEC route-update failure raw-releases held microphone audio', async () => {
  const transport: AecBridgeTransport = {
    async processAecFrame() { return { meetingId: 'm', frames: [] }; },
    async flushAec() { return { meetingId: 'm', frames: [] }; },
    async updateAecOutputRoute() { return null; },
  };
  const router = new MeetingAecRouter();
  const original = pcm(320, -13);
  const frameMetadata = { ...metadata(0, 0), sampleCount: 320 };
  assert.deepEqual(
    (await router.processPair(transport, 'm', original, pcm(320, 3), frameMetadata, frameMetadata)).mic,
    [],
  );
  assert.deepEqual(
    await router.updateOutputRoute(transport, 'm', true),
    [{ pcmBase64: original, metadata: { ...frameMetadata, sourceId: 'm.mic' } }],
  );
});

test('AEC router fail-opens every retained microphone batch when helper processing is unavailable', async () => {
  let calls = 0;
  const transport: AecBridgeTransport = {
    async processAecFrame() {
      calls += 1;
      return calls === 1 ? { meetingId: 'm', frames: [] } : null;
    },
    async flushAec() { return null; },
    async updateAecOutputRoute() { return null; },
  };
  const router = new MeetingAecRouter();
  const raw = pcm(640, -21);
  const result = await router.processPair(transport, 'm', raw, pcm(640, 7), metadata(0, 0), metadata(0, 0));

  assert.equal(result.active, false);
  assert.equal(result.failedOpen, true);
  assert.deepEqual(result.mic, [{ pcmBase64: raw, metadata: { ...metadata(0, 0), sourceId: 'm.mic' } }]);
  const next = await router.processPair(transport, 'm', pcm(640, 5), pcm(640, 5), metadata(640, 1), metadata(640, 1));
  assert.equal(next.active, false);
  assert.equal(next.mic[0]?.pcmBase64, pcm(640, 5));
});

test('AEC-to-ASR delivery drains the maximum four-held-plus-current fail-open burst without retrying', async () => {
  const transport: AecBridgeTransport = {
    async processAecFrame() { return { meetingId: 'm', frames: [] }; },
    async flushAec() { return { meetingId: 'm', frames: [] }; },
    async updateAecOutputRoute() { return { meetingId: 'm', frames: [] }; },
  };
  const router = new MeetingAecRouter();
  for (let index = 0; index < 4; index += 1) {
    const held = await router.processPair(
      transport,
      'm',
      pcm(320, index + 1),
      pcm(320, 0),
      { ...metadata(index * 320, index), sampleCount: 320 },
      { ...metadata(index * 320, index), sampleCount: 320 },
    );
    assert.deepEqual(held.mic, []);
  }

  const failOpen = await router.processPair(
    transport,
    'm',
    pcm(320, 5),
    pcm(320, 0),
    { ...metadata(1280, 4), sampleCount: 320 },
    { ...metadata(1280, 4), sampleCount: 320 },
  );
  assert.equal(failOpen.mic.length, 5);

  const queue = new AecAsrDeliveryQueue<number>();
  const delivered: number[] = [];
  const snapshots = await queue.accept(
    'm:mic:1280:4',
    async () => failOpen.mic,
    async (batch) => {
      const value = Buffer.from(batch.pcmBase64, 'base64').readInt16LE(0);
      delivered.push(value);
      return value;
    },
  );
  assert.deepEqual(delivered, [1, 2, 3, 4, 5]);
  assert.deepEqual(snapshots, delivered);
  assert.equal(queue.pendingBatches, 0);
});

test('AEC router advances the native epoch once per discontinuity and stamps every frame in that capture epoch', async () => {
  const epochs: number[] = [];
  const transport: AecBridgeTransport = {
    async processAecFrame(_meetingId, mic) {
      epochs.push(mic.epoch);
      return { meetingId: 'm', frames: [output(mic)] };
    },
    async flushAec() { return { meetingId: 'm', frames: [] }; },
    async updateAecOutputRoute() { return { meetingId: 'm', frames: [] }; },
  };
  const router = new MeetingAecRouter();
  const discontinuity = { ...metadata(0, 0), flags: ['discontinuity'] as MeetingAudioFeedFlag[] };
  await router.processPair(transport, 'm', pcm(640, 1), pcm(640, 1), discontinuity, discontinuity);
  await router.processPair(transport, 'm', pcm(640, 2), pcm(640, 2), metadata(640, 1), metadata(640, 1));
  const secondDrop = { ...metadata(1280, 2), flags: ['discontinuity'] as MeetingAudioFeedFlag[] };
  await router.processPair(transport, 'm', pcm(640, 3), pcm(640, 3), secondDrop, secondDrop);

  assert.deepEqual(epochs, [1, 1, 1, 1, 2, 2]);
});

test('system-only recovery drains the old AEC tail and starts a paired native epoch without changing mic ASR metadata', async () => {
  const calls: Array<{ mic: BridgeAecInputFrame; render: BridgeAecInputFrame }> = [];
  let held: BridgeAecInputFrame | null = null;
  const transport: AecBridgeTransport = {
    async processAecFrame(_meetingId, mic, render) {
      calls.push({ mic, render });
      const frames = held ? [output(held)] : [];
      held = mic;
      return { meetingId: 'm', frames };
    },
    async flushAec() {
      const frames = held ? [output(held)] : [];
      held = null;
      return { meetingId: 'm', frames };
    },
    async updateAecOutputRoute() { return { meetingId: 'm', frames: [] }; },
  };
  const router = new MeetingAecRouter();
  const first = await router.processPair(transport, 'm', pcm(640, 10), pcm(640, 1), metadata(0, 0), metadata(0, 0));
  assert.deepEqual(first.mic, []);

  const systemRecovery = {
    ...metadata(640, 1),
    flags: ['discontinuity', 'recovered'] as MeetingAudioFeedFlag[],
  };
  const transition = await router.processPair(
    transport,
    'm',
    pcm(640, 20),
    pcm(640, 2),
    metadata(640, 1),
    systemRecovery,
  );
  const tail = await router.flush(transport, 'm');

  // The retained old reblocker tail precedes the new epoch exactly once; the
  // mic's ASR metadata remains continuous because only system restarted.
  assert.deepEqual(transition.mic.map(batch => batch.pcmBase64), [pcm(640, 10)]);
  assert.deepEqual(transition.mic[0]?.metadata.flags, []);
  assert.deepEqual(tail.map(batch => batch.pcmBase64), [pcm(640, 20)]);
  assert.deepEqual(tail[0]?.metadata.flags, []);
  assert.deepEqual(calls.map(({ mic }) => mic.epoch), [0, 0, 1, 1]);
  assert.deepEqual(calls.slice(2).map(({ mic, render }) => [mic.flags.discontinuity, render.flags.discontinuity, mic.flags.recovered, render.flags.recovered]), [
    [true, true, true, true],
    [false, false, false, false],
  ]);
});

test('mic-only recovery starts the paired native epoch while retaining mic-only ASR recovery flags', async () => {
  const calls: Array<{ mic: BridgeAecInputFrame; render: BridgeAecInputFrame }> = [];
  const transport: AecBridgeTransport = {
    async processAecFrame(_meetingId, mic, render) {
      calls.push({ mic, render });
      return { meetingId: 'm', frames: [output(mic)] };
    },
    async flushAec() { return { meetingId: 'm', frames: [] }; },
    async updateAecOutputRoute() { return { meetingId: 'm', frames: [] }; },
  };
  const router = new MeetingAecRouter();
  await router.processPair(transport, 'm', pcm(640, 10), pcm(640, 1), metadata(0, 0), metadata(0, 0));
  const micRecovery = {
    ...metadata(640, 1),
    flags: ['discontinuity', 'recovered'] as MeetingAudioFeedFlag[],
  };
  const transition = await router.processPair(
    transport,
    'm',
    pcm(640, 20),
    pcm(640, 2),
    micRecovery,
    metadata(640, 1),
  );

  assert.deepEqual(transition.mic.map(batch => batch.pcmBase64), [pcm(640, 20)]);
  assert.deepEqual(transition.mic[0]?.metadata.flags, ['discontinuity', 'recovered']);
  assert.deepEqual(calls.map(({ mic }) => mic.epoch), [0, 0, 1, 1]);
  assert.deepEqual(calls.slice(2).map(({ mic, render }) => [mic.flags.discontinuity, render.flags.discontinuity, mic.flags.recovered, render.flags.recovered]), [
    [true, true, true, true],
    [false, false, false, false],
  ]);
});

test('AEC router rejects a result whose meeting id does not match the active capture', async () => {
  const transport: AecBridgeTransport = {
    async processAecFrame(_meetingId, mic) {
      return { meetingId: 'another-meeting', frames: [output(mic)] };
    },
    async flushAec() { return null; },
    async updateAecOutputRoute() { return null; },
  };
  const router = new MeetingAecRouter();
  const raw = pcm(640, 14);
  const result = await router.processPair(transport, 'm', raw, pcm(640, 1), metadata(0, 0), metadata(0, 0));
  assert.equal(result.failedOpen, true);
  assert.equal(result.mic[0]?.pcmBase64, raw);
});

test('AEC-to-ASR delivery retry never replays an already accepted microphone batch', async () => {
  const queue = new AecAsrDeliveryQueue<string>();
  const first: AecMicBatch = { pcmBase64: pcm(320, 1), metadata: metadata(0, 0) };
  const second: AecMicBatch = { pcmBase64: pcm(320, 2), metadata: metadata(320, 1) };
  const accepted: number[] = [];
  let failSecond = true;
  const deliver = async (batch: AecMicBatch): Promise<string> => {
    const value = Buffer.from(batch.pcmBase64, 'base64').readInt16LE(0);
    if (value === 2 && failSecond) {
      failSecond = false;
      throw new Error('worker interrupted after first batch');
    }
    accepted.push(value);
    return `snapshot:${value}`;
  };

  await assert.rejects(
    queue.accept('capture:0', async () => [first, second], deliver),
    /worker interrupted/,
  );
  assert.deepEqual(accepted, [1]);
  assert.equal(queue.pendingBatches, 1);

  const retry = await queue.accept('capture:0', async () => {
    throw new Error('AEC must not be called for the same renderer retry');
  }, deliver);
  assert.deepEqual(retry, ['snapshot:2']);
  assert.deepEqual(accepted, [1, 2]);
  assert.equal(queue.pendingBatches, 0);
});

test('an unrelated route or flush cannot drain a mic batch awaiting its exact renderer retry', async () => {
  const queue = new AecAsrDeliveryQueue<string>();
  const batch: AecMicBatch = { pcmBase64: pcm(320, 9), metadata: metadata(0, 0) };
  let fail = true;
  const delivered: number[] = [];
  const deliver = async (item: AecMicBatch) => {
    if (fail) {
      fail = false;
      throw new Error('worker failed');
    }
    const value = Buffer.from(item.pcmBase64, 'base64').readInt16LE(0);
    delivered.push(value);
    return `snapshot:${value}`;
  };

  await assert.rejects(queue.accept('capture:0', async () => [batch], deliver), /worker failed/);
  await assert.rejects(
    queue.accept('route:isolated', async () => [], deliver),
    /retry is pending for another input/,
  );
  assert.deepEqual(delivered, []);
  assert.equal(queue.pendingBatches, 1);

  assert.deepEqual(await queue.accept('capture:0', async () => {
    throw new Error('AEC must not rerun');
  }, deliver), ['snapshot:9']);
  assert.deepEqual(delivered, [9]);
  assert.equal(queue.pendingBatches, 0);
});

test('AEC feed and route update are serialized across the mutable router and delivery queue', async () => {
  let releaseProcess!: () => void;
  const processGate = new Promise<void>((resolve) => { releaseProcess = resolve; });
  const events: string[] = [];
  const transport: AecBridgeTransport = {
    async processAecFrame(_meetingId, mic) {
      events.push('process:start');
      await processGate;
      events.push('process:end');
      return { meetingId: 'm', frames: [output(mic)] };
    },
    async flushAec() { return { meetingId: 'm', frames: [] }; },
    async updateAecOutputRoute() {
      events.push('route');
      return { meetingId: 'm', frames: [] };
    },
  };
  const router = new MeetingAecRouter();
  const queue = new AecAsrDeliveryQueue<number>();
  const mic = pcm(320, 31);
  const render = pcm(320, 7);
  const frameMetadata = { ...metadata(0, 0), sampleCount: 320 };

  const feed = queue.accept(
    'm:mic:0:0',
    async () => (await router.processPair(transport, 'm', mic, render, frameMetadata, frameMetadata)).mic,
    async (batch) => {
      events.push('deliver');
      return Buffer.from(batch.pcmBase64, 'base64').readInt16LE(0);
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const route = queue.accept(
    'm:aec-route:isolated',
    () => router.updateOutputRoute(transport, 'm', true),
    async () => { throw new Error('route update unexpectedly released PCM'); },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ['process:start']);
  releaseProcess();
  assert.deepEqual(await feed, [31]);
  assert.deepEqual(await route, []);
  assert.deepEqual(events, ['process:start', 'process:end', 'deliver', 'route']);
  assert.equal(queue.pendingBatches, 0);
});
