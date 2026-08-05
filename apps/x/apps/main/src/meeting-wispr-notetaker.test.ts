import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  normalizeWisprRichText,
  parseWisprTranscriptEntry,
  WisprNotetakerSource,
  type WisprMeetingEvent,
} from './wispr-notetaker.js';

async function eventually(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('condition was not reached before timeout');
}

test('parses Wispr v3 entries without treating metadata as speech', () => {
  assert.equal(parseWisprTranscriptEntry({ meta: { v: 3 } }), null);
  assert.deepEqual(parseWisprTranscriptEntry({
    id: 'entry-1',
    text: 'Hello there',
    start_recording_ms: 1250,
    end_recording_ms: 1820,
    speaker: { id: '4', source: 'system', name: 'Akbar' },
  }), {
    id: 'entry-1',
    text: 'Hello there',
    startRecordingMs: 1250,
    endRecordingMs: 1820,
    speaker: { id: '4', source: 'system', name: 'Akbar' },
  });
});

test('normalizes plain Markdown and Lexical note content', () => {
  assert.equal(normalizeWisprRichText('## Notes\n\nHello'), '## Notes\n\nHello');
  assert.equal(normalizeWisprRichText(JSON.stringify({
    root: { children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Action item' }] }] },
  })), 'Action item');
});

test('optionally installs the local accelerator and reconciles provisional speaker text from live.ndjson', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'rowboat-wispr-test-'));
  const home = path.join(root, 'home');
  const flow = path.join(home, 'Library', 'Application Support', 'Wispr Flow');
  const rowboat = path.join(home, '.rowboat');
  const extensionSource = path.join(root, 'source');
  const extensionEntry = path.join(extensionSource, 'extensions', 'rowboat-notetaker', 'dist', 'index.js');
  const wisprApp = path.join(root, 'Wispr Flow.app');
  await fsp.mkdir(path.dirname(extensionEntry), { recursive: true });
  await fsp.writeFile(extensionEntry, 'module.exports.default = { main() {} };\n');
  await fsp.mkdir(wisprApp, { recursive: true });
  await fsp.mkdir(path.join(flow, 'extensions'), { recursive: true });
  await fsp.writeFile(path.join(flow, 'extensions', 'custom-paths.json'), JSON.stringify(['/keep/me']));
  await fsp.writeFile(path.join(flow, 'extensions', 'extensions-state.json'), JSON.stringify({ existing: true }));

  const events: WisprMeetingEvent[] = [];
  const source = new WisprNotetakerSource({
    platform: 'darwin',
    homeDirectory: home,
    flowSupportDirectory: flow,
    rowboatDirectory: rowboat,
    wisprApplicationPath: wisprApp,
    extensionSourceRoot: extensionSource,
    onEvent: (event) => events.push(event),
  });

  try {
    const installed = await source.install();
    assert.equal(installed.connectorInstalled, true);
    const customPaths = JSON.parse(await fsp.readFile(path.join(flow, 'extensions', 'custom-paths.json'), 'utf8'));
    assert.deepEqual(customPaths, ['/keep/me', path.join(rowboat, 'integrations', 'wispr-flow')]);
    const enabled = JSON.parse(await fsp.readFile(path.join(flow, 'extensions', 'extensions-state.json'), 'utf8'));
    assert.deepEqual(enabled, { existing: true, 'rowboat-notetaker': true });

    // The unit-test sandbox blocks listening on Unix sockets. Inject a chunk
    // at the same private boundary used by the optional authenticated stream.
    (source as unknown as { authenticatedClients: number }).authenticatedClients = 1;
    await source.begin('rowboat-test');
    await (source as unknown as {
      receiveChunk(meetingId: string, text: string, name?: string): Promise<void>
    }).receiveChunk('wispr-meeting', 'Hello from this meeting');
    await eventually(() => events.length >= 1);
    assert.equal(events[0]?.segments[0]?.speaker.kind, 'unknown');

    const meetingDir = path.join(flow, 'meetings', 'wispr-meeting');
    await fsp.mkdir(meetingDir, { recursive: true });
    await fsp.writeFile(path.join(meetingDir, 'live.ndjson'), [
      JSON.stringify({ meta: { v: 3, clock: 'recording_active_ms' } }),
      JSON.stringify({
        id: 'live-1',
        text: 'Hello from this meeting',
        startRecordingMs: 500,
        endRecordingMs: 1400,
        speaker: { id: 'self', source: 'mic', name: null },
      }),
      '',
    ].join('\n'));
    await (source as unknown as {
      reconcileTranscriptFile(file: string): Promise<unknown>
    }).reconcileTranscriptFile(path.join(meetingDir, 'live.ndjson'));
    await eventually(() => events.some((event) => event.segments.some((segment) => segment.speaker.kind === 'self')));
    const reconciled = events.flatMap((event) => event.segments).find((segment) => segment.speaker.kind === 'self');
    assert.equal(reconciled?.speaker.displayName, 'You');
    assert.equal(reconciled?.channel, 'mic');
    assert.equal(reconciled?.revision, 1);
    assert.equal(reconciled?.segmentId, events[0]?.segments[0]?.segmentId);
  } finally {
    await source.dispose();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('starts from an active Wispr local meeting without the extension stream', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'rowboat-wispr-files-test-'));
  const home = path.join(root, 'home');
  const flow = path.join(home, 'Library', 'Application Support', 'Wispr Flow');
  const rowboat = path.join(home, '.rowboat');
  const wisprApp = path.join(root, 'Wispr Flow.app');
  const wisprMeetingId = 'wispr-local-meeting';
  const meetingDir = path.join(flow, 'meetings', wisprMeetingId);
  await fsp.mkdir(meetingDir, { recursive: true });
  await fsp.mkdir(wisprApp, { recursive: true });
  await fsp.writeFile(path.join(meetingDir, 'live.ndjson'), `${JSON.stringify({
    id: 'local-1',
    text: 'Local append log works',
    startRecordingMs: 250,
    endRecordingMs: 900,
    speaker: { id: 'self', source: 'mic', name: null },
  })}\n`);
  const database = new DatabaseSync(path.join(flow, 'flow.sqlite'));
  database.exec(`
    CREATE TABLE Meetings (
      id TEXT PRIMARY KEY,
      createdAt TEXT NOT NULL,
      isDeleted INTEGER NOT NULL,
      finalized INTEGER NOT NULL,
      endedAt INTEGER
    );
  `);
  database.prepare(`
    INSERT INTO Meetings (id, createdAt, isDeleted, finalized, endedAt)
    VALUES (?, ?, 0, 0, NULL)
  `).run(wisprMeetingId, new Date().toISOString());
  database.close();

  const ended: string[] = [];
  const source = new WisprNotetakerSource({
    platform: 'darwin',
    homeDirectory: home,
    flowSupportDirectory: flow,
    rowboatDirectory: rowboat,
    wisprApplicationPath: wisprApp,
    extensionSourceRoot: path.join(root, 'unused-extension'),
    onEvent: () => {},
    onEnded: (event) => ended.push(event.wisprMeetingId),
  });

  try {
    await source.setPreferred(true);
    const status = await source.getStatus();
    assert.equal(status.connected, true);
    assert.equal(status.extensionConnected, false);
    assert.equal(status.connectorInstalled, false);
    const initial = await source.begin('rowboat-local-test');
    assert.equal(initial.wisprMeetingId, wisprMeetingId);
    assert.equal(initial.segments.length, 1);
    assert.equal(initial.segments[0]?.speaker.kind, 'self');
    assert.equal(initial.segments[0]?.speaker.displayName, 'You');
    await fsp.writeFile(path.join(meetingDir, 'refined.ndjson'), `${JSON.stringify({
      id: 'local-1',
      text: 'Local append log works',
      startRecordingMs: 250,
      endRecordingMs: 900,
      speaker: { id: 'self', source: 'refined', name: null },
    })}\n`);
    await eventually(() => ended.length === 1);
    assert.deepEqual(ended, [wisprMeetingId]);
  } finally {
    await source.dispose();
    await fsp.rm(root, { recursive: true, force: true });
  }
});
