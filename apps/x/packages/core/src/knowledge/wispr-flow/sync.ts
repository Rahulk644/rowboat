import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client';
import { WorkDir } from '../../config/config.js';
import { publishMeetingNotesReadyEvent } from '../meeting-events.js';
import { WisprFlowClientFactory } from './client-factory.js';

const SYNC_DIR = path.join(WorkDir, 'knowledge', 'Meetings', 'wispr-flow');
const STATE_FILE = path.join(WorkDir, 'wispr_flow_sync_state.json');
const SYNC_INTERVAL_MS = 90_000;
const MAX_MEETINGS_PER_RUN = 8;

type JsonObject = Record<string, unknown>;
type McpTool = {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
};

export type NormalizedWisprMeeting = {
  id: string;
  title: string;
  occurredAt: string;
  endedAt?: string;
  participants: string[];
  thoughts?: string;
  summary?: string;
  actionItems: string[];
  transcript?: string;
  finalized: boolean;
};

type SyncState = {
  version: 2;
  baselineComplete: boolean;
  synced: Record<string, { contentHash: string; filePath: string; importedAt: string }>;
  ignoredBaselineIds: string[];
};

let wake: (() => void) | null = null;
let running = false;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function firstValue(object: JsonObject, keys: string[]): unknown {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
}

function textValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  const object = asObject(value);
  if (!object) return undefined;
  return textValue(firstValue(object, ['markdown', 'text', 'content', 'value', 'body']));
}

function isoValue(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function participantNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value.flatMap((item) => {
    if (typeof item === 'string') return [item.trim()];
    const object = asObject(item);
    const name = object && textValue(firstValue(object, ['displayName', 'display_name', 'name', 'email']));
    return name ? [name] : [];
  }).filter(Boolean);
  return [...new Set(names)].slice(0, 200);
}

function actionItemTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items = value.flatMap((item) => {
    if (typeof item === 'string') return [item.trim()];
    const object = asObject(item);
    const text = object && textValue(firstValue(object, [
      'text', 'title', 'description', 'content', 'task', 'todo', 'actionItem', 'action_item',
    ]));
    return text ? [text] : [];
  }).filter(Boolean);
  return [...new Set(items)].slice(0, 200);
}

type NormalizedTranscript = {
  text?: string;
  speakers: string[];
};

function isGenericSpeakerName(value: string): boolean {
  return /^(?:speaker[ _-]*\d+|unknown(?: speaker)?|you|them)$/i.test(value.trim());
}

function dedupeNames(values: string[]): string[] {
  const names = new Map<string, string>();
  for (const value of values) {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized && !names.has(normalized.toLocaleLowerCase())) {
      names.set(normalized.toLocaleLowerCase(), normalized);
    }
  }
  return [...names.values()].slice(0, 200);
}

/**
 * Wispr returns its transcript as one plain-text line per turn (`Name: text`).
 * Rowboat's legacy transcript block accepts the same turns only as
 * `**Name:** text`. Preserve already-normalized turns, drop Wispr's sentinel
 * banner, and provide an Unknown speaker turn for unlabeled plain text so a
 * valid transcript can never render as an invalid block.
 */
function normalizeTranscriptForRowboat(value: string | undefined): NormalizedTranscript {
  if (!value) return { speakers: [] };
  const output: string[] = [];
  const speakers: string[] = [];
  let sawTurn = false;

  for (const rawLine of value.split('\n')) {
    const line = rawLine.trim();
    if (!line || /^<<<.*>>>$/.test(line)) continue;

    const markdownTurn = line.match(/^\*\*([^*:\n]{1,120}):\*\*\s*(.*)$/);
    if (markdownTurn) {
      const speaker = markdownTurn[1].replace(/\s+/g, ' ').trim();
      output.push(`**${speaker}:** ${markdownTurn[2].trim()}`);
      speakers.push(speaker);
      sawTurn = true;
      continue;
    }

    const plainTurn = line.match(/^([^*:\n]{1,120}):\s+(.*)$/);
    if (plainTurn && /\p{L}/u.test(plainTurn[1])) {
      const speaker = plainTurn[1].replace(/\s+/g, ' ').trim();
      output.push(`**${speaker}:** ${plainTurn[2].trim()}`);
      speakers.push(speaker);
      sawTurn = true;
      continue;
    }

    if (sawTurn && output.length > 0) output[output.length - 1] += ` ${line}`;
    else output.push(line);
  }

  const text = output.join('\n').trim();
  if (!text) return { speakers: [] };
  if (!sawTurn) return { text: `**Unknown speaker:** ${text}`, speakers: [] };
  return { text, speakers: dedupeNames(speakers) };
}

function transcriptText(value: unknown): string | undefined {
  const direct = textValue(value);
  if (direct) return direct;
  const object = asObject(value);
  if (object) {
    return transcriptText(firstValue(object, ['sentences', 'segments', 'utterances', 'entries', 'items']));
  }
  if (!Array.isArray(value)) return undefined;
  const lines: string[] = [];
  let previousSpeaker = '';
  for (const item of value) {
    if (typeof item === 'string') {
      if (item.trim()) lines.push(item.trim());
      continue;
    }
    const entry = asObject(item);
    if (!entry) continue;
    const text = textValue(firstValue(entry, ['text', 'content', 'transcript', 'utterance']));
    if (!text) continue;
    const speaker = textValue(firstValue(entry, [
      'speakerName', 'speaker_name', 'displayName', 'speaker', 'participantName',
    ]));
    const resolvedSpeaker = speaker && speaker !== '[object Object]' ? speaker : 'Unknown speaker';
    if (resolvedSpeaker !== previousSpeaker) {
      if (lines.length > 0) lines.push('');
      lines.push(`**${resolvedSpeaker}:** ${text}`);
      previousSpeaker = resolvedSpeaker;
    } else {
      lines[lines.length - 1] = `${lines[lines.length - 1]} ${text}`;
    }
  }
  const joined = lines.join('\n').trim();
  return joined || undefined;
}

export function normalizeWisprMeeting(value: unknown): NormalizedWisprMeeting | null {
  const object = asObject(value);
  if (!object) return null;
  const nested = asObject(firstValue(object, ['meeting', 'note', 'notetakerMeeting', 'data']));
  const source = nested ? { ...object, ...nested } : object;
  const id = textValue(firstValue(source, [
    'id', 'meetingId', 'meeting_id', 'noteId', 'note_id', 'uuid',
  ]));
  if (!id) return null;

  const summary = textValue(firstValue(source, [
    'summary', 'meetingSummary', 'meeting_summary', 'brief', 'overview',
  ]));
  const thoughts = textValue(firstValue(source, [
    'myThoughts', 'my_thoughts', 'thoughts', 'notes', 'userNotes', 'user_notes', 'content',
  ]));
  const rawTranscript = transcriptText(firstValue(source, [
    'transcript', 'rawTranscript', 'raw_transcript', 'sentences', 'segments', 'utterances',
  ]));
  const normalizedTranscript = normalizeTranscriptForRowboat(rawTranscript);
  const transcript = normalizedTranscript.text;
  if (!transcript && !summary && !thoughts) return null;

  const rawStatus = textValue(firstValue(source, ['status', 'state', 'processingStatus']))?.toLowerCase();
  const explicitFinal = firstValue(source, ['finalized', 'isFinalized', 'is_finalized', 'complete', 'completed']);
  const statusFinal = rawStatus
    ? ['complete', 'completed', 'done', 'final', 'finalized', 'ready', 'processed'].includes(rawStatus)
    : false;
  const statusActive = rawStatus
    ? ['active', 'capturing', 'in_progress', 'in progress', 'processing', 'recording'].includes(rawStatus)
    : false;
  // Wispr's summary/thoughts are post-call artifacts. If the connector omits a
  // status flag, their presence alongside a transcript is the conservative
  // finalization signal. Transcript-only live meetings are never imported.
  const finalized = !statusActive && (
    explicitFinal === true || statusFinal || Boolean(summary || thoughts)
  );

  const occurredAt = isoValue(firstValue(source, [
    'startedAt', 'started_at', 'start', 'date', 'createdAt', 'created_at', 'meetingDate',
  ])) ?? new Date().toISOString();
  const endedAt = isoValue(firstValue(source, [
    'endedAt', 'ended_at', 'end', 'completedAt', 'completed_at', 'updatedAt', 'updated_at',
    'modifiedAt', 'modified_at',
  ]));
  const title = (textValue(firstValue(source, ['title', 'meetingTitle', 'meeting_title', 'name']))
    ?? 'Wispr meeting').replace(/\s+/g, ' ').slice(0, 240);
  const explicitParticipants = participantNames(firstValue(source, [
    'participants', 'attendees', 'people', 'participantNames', 'participant_names',
  ]));
  const transcriptParticipants = normalizedTranscript.speakers.filter((name) => !isGenericSpeakerName(name));
  const participants = dedupeNames([...explicitParticipants, ...transcriptParticipants]);
  const actionItems = actionItemTexts(firstValue(source, [
    'todos', 'toDos', 'actionItems', 'action_items', 'tasks',
  ]));

  return { id, title, occurredAt, ...(endedAt ? { endedAt } : {}), participants,
    ...(thoughts ? { thoughts } : {}), ...(summary ? { summary } : {}), actionItems,
    ...(transcript ? { transcript } : {}), finalized };
}

function collectObjects(value: unknown, depth = 0): JsonObject[] {
  if (depth > 5) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectObjects(item, depth + 1));
  const object = asObject(value);
  if (!object) return [];
  return [object, ...Object.values(object).flatMap((item) => collectObjects(item, depth + 1))];
}

function extractPayloads(result: unknown): unknown[] {
  const root = asObject(result);
  if (!root) return [];
  const payloads: unknown[] = [];
  if (root.structuredContent !== undefined) payloads.push(root.structuredContent);
  if (Array.isArray(root.content)) {
    for (const item of root.content) {
      const content = asObject(item);
      if (!content) continue;
      if (content.type === 'text' && typeof content.text === 'string') {
        try { payloads.push(JSON.parse(content.text)); }
        catch { /* Plain prose is not a stable sync contract. */ }
      }
      const resource = asObject(content.resource);
      if (resource && typeof resource.text === 'string') {
        try { payloads.push(JSON.parse(resource.text)); }
        catch { /* Ignore non-JSON embedded resources. */ }
      }
    }
  }
  return payloads;
}

function toolScore(tool: McpTool, mode: 'list' | 'detail'): number {
  const haystack = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
  let score = 0;
  if (/meeting|notetaker/.test(haystack)) score += 6;
  if (/note/.test(haystack)) score += 2;
  if (mode === 'list' && /list|search|recent|history/.test(haystack)) score += 5;
  if (mode === 'detail' && /get|fetch|retrieve|detail|transcript/.test(haystack)) score += 5;
  if (mode === 'list' && /get|detail/.test(haystack)) score -= 2;
  if (mode === 'detail' && /list|search|recent/.test(haystack)) score -= 2;
  return score;
}

export function chooseWisprTools(tools: McpTool[]): { list: McpTool; detail?: McpTool } {
  // Wispr's public MCP contract currently exposes these canonical names. Use
  // them when present so similarly described calendar tools (for example
  // get_upcoming_meeting) cannot win a heuristic tie.
  const canonicalList = tools.find((tool) => tool.name === 'search_meetings');
  const canonicalDetail = tools.find((tool) => tool.name === 'get_meeting');
  if (canonicalList) {
    return {
      list: canonicalList,
      ...(canonicalDetail ? { detail: canonicalDetail } : {}),
    };
  }

  const rankedList = [...tools].sort((a, b) => toolScore(b, 'list') - toolScore(a, 'list'));
  const list = rankedList[0];
  if (!list || toolScore(list, 'list') < 6) {
    throw new Error('Wispr MCP did not expose a recognizable Notetaker meeting search tool');
  }
  const detail = [...tools]
    .filter((tool) => tool.name !== list.name)
    .sort((a, b) => toolScore(b, 'detail') - toolScore(a, 'detail'))[0];
  return { list, ...(detail && toolScore(detail, 'detail') >= 6 ? { detail } : {}) };
}

function schemaProperties(tool: McpTool): JsonObject {
  return asObject(tool.inputSchema?.properties) ?? {};
}

export function listArguments(tool: McpTool): JsonObject {
  const properties = schemaProperties(tool);
  const args: JsonObject = {};
  for (const key of Object.keys(properties)) {
    const lower = key.toLowerCase();
    if (['limit', 'pagesize', 'page_size', 'maxresults', 'max_results'].includes(lower)) args[key] = 50;
    // Wispr's search_meetings contract lists recently modified meetings when
    // query is omitted. Supplying a generic word such as "meeting" filters by
    // title/content and silently hides ordinary meeting titles.
  }
  return args;
}

export function detailArguments(tool: McpTool, meetingId: string): JsonObject | null {
  const properties = schemaProperties(tool);
  for (const key of Object.keys(properties)) {
    if (/^(id|meeting_?id|note_?id|notetaker_?id|transcript_?id)$/i.test(key)) {
      const args: JsonObject = { [key]: meetingId };
      if ('view_content' in properties) {
        args.view_content = { start_char: 0, char_limit: 40_000 };
      }
      if ('view_transcript' in properties) {
        args.view_transcript = { start_char: 0, char_limit: 40_000 };
      }
      return args;
    }
  }
  return null;
}

function cleanFilename(value: string): string {
  return value.replace(/[\\/*?:"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Wispr meeting';
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function meetingToMarkdown(meeting: NormalizedWisprMeeting): string {
  const lines = [
    '---',
    'type: meeting',
    'source: wispr-flow',
    `wispr_meeting_id: ${yamlString(meeting.id)}`,
    `title: ${yamlString(meeting.title)}`,
    `date: ${yamlString(meeting.occurredAt)}`,
    ...(meeting.endedAt ? [`ended_at: ${yamlString(meeting.endedAt)}`] : []),
    `participants: ${JSON.stringify(meeting.participants)}`,
    '---',
    '',
    `# ${meeting.title}`,
    '',
  ];
  if (meeting.thoughts) lines.push('## My thoughts', '', meeting.thoughts, '');
  if (meeting.summary) lines.push('## Summary', '', meeting.summary, '');
  if (meeting.actionItems.length > 0) {
    lines.push('## Action items', '', ...meeting.actionItems.map((item) => `- ${item}`), '');
  }
  if (meeting.transcript) {
    lines.push('## Transcript', '', '```transcript', JSON.stringify({ transcript: meeting.transcript }), '```', '');
  } else {
    lines.push('## Transcript', '', '_Not available from Wispr Flow for this meeting._', '');
  }
  return lines.join('\n');
}

function defaultState(): SyncState {
  return { version: 2, baselineComplete: false, synced: {}, ignoredBaselineIds: [] };
}

function loadState(): SyncState {
  try {
    if (!fs.existsSync(STATE_FILE)) return defaultState();
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<SyncState>;
    if (parsed.version !== 2) return defaultState();
    return {
      version: 2,
      baselineComplete: parsed.baselineComplete === true,
      synced: parsed.synced ?? {},
      ignoredBaselineIds: Array.isArray(parsed.ignoredBaselineIds) ? parsed.ignoredBaselineIds : [],
    };
  } catch {
    return defaultState();
  }
}

function saveState(state: SyncState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const temporary = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(temporary, STATE_FILE);
}

async function fetchMeetings(client: Client): Promise<NormalizedWisprMeeting[]> {
  const listed = await client.listTools();
  const tools = listed.tools as McpTool[];
  const selected = chooseWisprTools(tools);
  console.log(`[Wispr Flow] MCP tools: ${tools.map((tool) => tool.name).join(', ')}`);
  const listResult = await client.callTool({ name: selected.list.name, arguments: listArguments(selected.list) });
  const candidates = extractPayloads(listResult).flatMap((payload) => collectObjects(payload));
  const byId = new Map<string, NormalizedWisprMeeting>();
  for (const candidate of candidates) {
    const normalized = normalizeWisprMeeting(candidate);
    if (normalized) byId.set(normalized.id, normalized);
  }

  if (selected.detail) {
    const ids = new Set<string>();
    for (const object of candidates) {
      const id = textValue(firstValue(object, ['id', 'meetingId', 'meeting_id', 'noteId', 'note_id', 'uuid']));
      if (id) ids.add(id);
      if (ids.size >= MAX_MEETINGS_PER_RUN) break;
    }
    for (const id of ids) {
      const args = detailArguments(selected.detail, id);
      if (!args) break;
      const detailResult = await client.callTool({ name: selected.detail.name, arguments: args });
      for (const payload of extractPayloads(detailResult)) {
        for (const object of collectObjects(payload)) {
          const normalized = normalizeWisprMeeting(object);
          if (normalized) byId.set(normalized.id, normalized);
        }
      }
    }
  }
  return [...byId.values()];
}

async function syncOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const client = await WisprFlowClientFactory.getClient();
    if (!client) return;
    const meetings = await fetchMeetings(client);
    const finalized = meetings.filter((meeting) => meeting.finalized);
    const state = loadState();

    // Connecting Wispr must not silently backfill a user's full meeting
    // history. Existing finalized IDs form a baseline; an in-progress meeting
    // is intentionally not baselined and will import after Wispr finalizes it.
    if (!state.baselineComplete) {
      state.ignoredBaselineIds = finalized.map((meeting) => meeting.id).slice(-500);
      state.baselineComplete = true;
      saveState(state);
      console.log(`[Wispr Flow] Baseline recorded (${state.ignoredBaselineIds.length} existing meetings)`);
      return;
    }

    const ignored = new Set(state.ignoredBaselineIds);
    fs.mkdirSync(SYNC_DIR, { recursive: true });
    for (const meeting of finalized.slice(0, MAX_MEETINGS_PER_RUN)) {
      if (ignored.has(meeting.id)) continue;
      const markdown = meetingToMarkdown(meeting);
      const contentHash = createHash('sha256').update(markdown).digest('hex');
      const existing = state.synced[meeting.id];
      if (existing?.contentHash === contentHash) continue;

      const occurredAt = new Date(meeting.occurredAt);
      const date = Number.isFinite(occurredAt.getTime()) ? occurredAt : new Date();
      const directory = path.join(
        SYNC_DIR,
        String(date.getFullYear()),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
      );
      fs.mkdirSync(directory, { recursive: true });
      const suffix = createHash('sha256').update(meeting.id).digest('hex').slice(0, 8);
      const filePath = path.join(directory, `${cleanFilename(meeting.title)}--${suffix}.md`);
      const temporary = `${filePath}.tmp`;
      fs.writeFileSync(temporary, markdown, 'utf8');
      fs.renameSync(temporary, filePath);
      state.synced[meeting.id] = { contentHash, filePath, importedAt: new Date().toISOString() };
      saveState(state);

      if (!existing) {
        await publishMeetingNotesReadyEvent({
          source: 'wispr-flow',
          title: meeting.title,
          filePath,
          when: meeting.endedAt ?? meeting.occurredAt,
        });
      }
      console.log(`[Wispr Flow] ${existing ? 'Updated' : 'Imported'} ${meeting.title}`);
    }
  } catch (error) {
    console.error('[Wispr Flow] Sync failed:', error);
  } finally {
    running = false;
  }
}

function sleep(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { wake = null; resolve(); }, SYNC_INTERVAL_MS);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });
}

export function triggerSync(): void {
  wake?.();
}

export async function init(): Promise<never> {
  while (true) {
    if (await WisprFlowClientFactory.hasCredentials()) await syncOnce();
    await sleep();
  }
}
