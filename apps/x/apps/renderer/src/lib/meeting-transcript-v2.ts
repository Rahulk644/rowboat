/**
 * The transcript-v2 block is Rowboat's only live-meeting-owned document
 * region.  Everything outside its fenced block belongs to the user (or a
 * separate note-generation workflow) and is deliberately left untouched by
 * live transcription updates.
 *
 * The bridge is the authority for speaker attribution.  This module only
 * stores and renders that evidence; it must never infer that a microphone is
 * "You" or that playback is one remote participant.
 */

import { meetingEcho } from '@x/shared'

export const TRANSCRIPT_V2_VERSION = 2 as const
export const TRANSCRIPT_V2_FENCE = 'transcript-v2'

export type TranscriptChannel = 'mic' | 'system'
export type TranscriptFinality = 'interim' | 'stable' | 'final'
export type SpeakerKind = 'self' | 'named' | 'cluster' | 'unknown'

export interface TranscriptSpeaker {
  kind: SpeakerKind
  id?: string
  displayName: string
}

export interface TranscriptSegment {
  meetingId?: string
  segmentId: string
  revision: number
  /** Monotonic per-channel capture generation. Omitted by older bridges. */
  epoch?: number
  startSample: number
  endSample: number
  timingConfidence: 'high' | 'medium' | 'low'
  channel: TranscriptChannel
  text: string
  finality: TranscriptFinality
  clusterIds: string[]
  overlap: boolean
  speaker: TranscriptSpeaker
  attributionSource?: string
  attributionConfidence?: number
  supersedes?: string[]
}

export interface TranscriptV2Block {
  version: typeof TRANSCRIPT_V2_VERSION
  /**
   * Compatibility projection for older transcript consumers.  It is derived
   * from `segments`, never used as an update source for a v2 block.
   */
  transcript: string
  segments: TranscriptSegment[]
}

/**
 * A renderer-only turn. `sourceSegments` always points to the canonical
 * records that produced the displayed text; it is never serialized back into
 * the transcript-v2 block.
 */
export interface TranscriptDisplayEntry {
  sourceSegments: TranscriptSegment[]
  text: string
  channel: TranscriptChannel
  speaker: TranscriptSpeaker
  overlap: boolean
  finality: TranscriptFinality
}

export interface SpeakerCorrectionRequest {
  meetingId?: string
  segmentId: string
  displayName: string
  /** Voice profiles are biometric-adjacent. Never opt in by default. */
  rememberVoice: boolean
}

/**
 * A grouped display turn still consists of distinct canonical records. Keep
 * the correction RPC exact for every record, and enroll a voice at most once
 * when the person has explicitly opted in.
 */
export function createSpeakerCorrectionRequests(
  segments: readonly Pick<TranscriptSegment, 'meetingId' | 'segmentId'>[],
  displayName: string,
  rememberVoice: boolean,
): SpeakerCorrectionRequest[] {
  return segments.map((segment, index) => ({
    meetingId: segment.meetingId,
    segmentId: segment.segmentId,
    displayName,
    rememberVoice: index === 0 && rememberVoice,
  }))
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asFiniteNonNegative(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isSpeakerKind(value: unknown): value is SpeakerKind {
  return value === 'self' || value === 'named' || value === 'cluster' || value === 'unknown'
}

function isFinality(value: unknown): value is TranscriptFinality {
  return value === 'interim' || value === 'stable' || value === 'final'
}

function isChannel(value: unknown): value is TranscriptChannel {
  return value === 'mic' || value === 'system'
}

function isTimingConfidence(value: unknown): value is TranscriptSegment['timingConfidence'] {
  return value === 'high' || value === 'medium' || value === 'low'
}

export function unknownSpeaker(): TranscriptSpeaker {
  return { kind: 'unknown', displayName: 'Unknown speaker' }
}

/**
 * Explicit `self` evidence is the only way the renderer may display `You`.
 * A missing/invalid speaker always remains Unknown, regardless of channel.
 */
export function normalizeSpeaker(value: unknown): TranscriptSpeaker {
  if (!isRecord(value)) return unknownSpeaker()

  const kind = isSpeakerKind(value.kind) ? value.kind : 'unknown'
  const displayName = asString(value.displayName) ?? asString(value.display_name)
  const id = asString(value.id)

  if (kind === 'self') return { kind, id, displayName: displayName ?? 'You' }
  if (kind === 'named') return displayName ? { kind, id, displayName } : unknownSpeaker()
  if (kind === 'cluster') return {
    kind,
    id,
    displayName: displayName ?? (id ? `Speaker ${id}` : 'Anonymous speaker'),
  }
  return unknownSpeaker()
}

/**
 * Validate the canonical bridge event while accepting a small set of legacy
 * aliases so a renderer upgrade can precede the main-process upgrade.
 */
export function normalizeTranscriptSegment(value: unknown): TranscriptSegment | null {
  if (!isRecord(value)) return null
  const segmentId = asString(value.segmentId) ?? asString(value.id)
  const text = asString(value.text)
  if (!segmentId || !text) return null

  const channel = isChannel(value.channel) ? value.channel : 'system'
  const startSample = asFiniteNonNegative(value.startSample, asFiniteNonNegative(value.startMs))
  const endSample = Math.max(startSample, asFiniteNonNegative(value.endSample, asFiniteNonNegative(value.endMs, startSample)))
  const clusterIds = Array.isArray(value.clusterIds)
    ? value.clusterIds.flatMap(item => asString(item) ? [asString(item)!] : [])
    : []

  return {
    meetingId: asString(value.meetingId),
    segmentId,
    revision: Math.floor(asFiniteNonNegative(value.revision)),
    ...(typeof value.epoch === 'number' && Number.isFinite(value.epoch) && value.epoch >= 0
      ? { epoch: Math.floor(value.epoch) }
      : {}),
    startSample,
    endSample,
    timingConfidence: isTimingConfidence(value.timingConfidence) ? value.timingConfidence : 'low',
    channel,
    text,
    finality: isFinality(value.finality) ? value.finality : 'interim',
    clusterIds,
    overlap: value.overlap === true,
    speaker: normalizeSpeaker(value.speaker),
    attributionSource: asString(value.attributionSource),
    attributionConfidence: typeof value.attributionConfidence === 'number' && Number.isFinite(value.attributionConfidence)
      ? value.attributionConfidence
      : undefined,
    supersedes: Array.isArray(value.supersedes)
      ? value.supersedes.flatMap(item => asString(item) ? [asString(item)!] : [])
      : undefined,
  }
}

export function normalizeTranscriptSegments(value: unknown): TranscriptSegment[] {
  const rawSegments = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.segments)
      ? value.segments
      : []
  return rawSegments.flatMap(segment => {
    const normalized = normalizeTranscriptSegment(segment)
    return normalized ? [normalized] : []
  })
}

/**
 * A canonical snapshot may legitimately contain no segment upserts. Callers
 * must treat that as a v2 no-op rather than replaying its legacy cumulative
 * text fields into a second transcript representation.
 */
export function isCanonicalTranscriptSnapshot(value: unknown): boolean {
  return isRecord(value) && (value.version === TRANSCRIPT_V2_VERSION || Array.isArray(value.segments))
}

function compareSegments(a: TranscriptSegment, b: TranscriptSegment): number {
  return (a.epoch ?? 0) - (b.epoch ?? 0)
    || a.startSample - b.startSample
    || a.endSample - b.endSample
    || a.segmentId.localeCompare(b.segmentId)
}

const MAX_DISPLAY_CONTINUITY_GAP_SAMPLES = 1_600

type TranscriptToken = {
  normalized: string
  start: number
}

function transcriptTokens(text: string): TranscriptToken[] {
  const tokens: TranscriptToken[] = []
  const matcher = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu
  for (let match = matcher.exec(text); match; match = matcher.exec(text)) {
    tokens.push({ normalized: match[0].toLocaleLowerCase(), start: match.index })
  }
  return tokens
}

/**
 * Returns a display-only de-duplicated join when `next` clearly extends or
 * overlaps `current`. This deliberately does not use fuzzy matching: a
 * mistaken word must remain visible rather than being silently discarded.
 */
function joinOverlappingTranscriptText(current: string, next: string, allowSingleTokenOverlap: boolean): string | null {
  const left = transcriptTokens(current)
  const right = transcriptTokens(next)
  if (left.length === 0 || right.length === 0) return null

  const same = (leftIndex: number, rightIndex: number, length: number): boolean => (
    Array.from({ length }).every((_, offset) => left[leftIndex + offset]?.normalized === right[rightIndex + offset]?.normalized)
  )

  // A later ASR snapshot that begins with the full current text replaces it;
  // retaining `next` preserves its most recent punctuation and casing.
  if (right.length >= left.length && same(0, 0, left.length)) return next.trim()
  // A shorter replay adds no new words, so keep the current display spelling.
  if (left.length >= right.length && same(0, 0, right.length)) return current.trim()

  const minimumOverlap = allowSingleTokenOverlap ? 1 : 2
  const maximumOverlap = Math.min(left.length, right.length)
  for (let overlap = maximumOverlap; overlap >= minimumOverlap; overlap--) {
    if (!same(left.length - overlap, 0, overlap)) continue
    const suffixStart = right[overlap]?.start
    if (suffixStart === undefined) return current.trim()
    return `${current.trimEnd()} ${next.slice(suffixStart).trimStart()}`.trim()
  }
  return null
}

function sameSpeaker(left: TranscriptSpeaker, right: TranscriptSpeaker): boolean {
  return left.kind === right.kind && left.id === right.id && left.displayName === right.displayName
}

function isExplicitSpeakerCorrection(segment: TranscriptSegment): boolean {
  return segment.attributionSource === 'explicit-user-correction'
}

function displayFinality(sourceSegments: readonly TranscriptSegment[]): TranscriptFinality {
  if (sourceSegments.some(segment => segment.finality === 'interim')) return 'interim'
  if (sourceSegments.some(segment => segment.finality === 'stable')) return 'stable'
  return 'final'
}

function canJoinDisplayEntry(current: TranscriptDisplayEntry, next: TranscriptSegment): boolean {
  const last = current.sourceSegments[current.sourceSegments.length - 1]
  if (!last) return false
  if (last.meetingId !== next.meetingId || (last.epoch ?? 0) !== (next.epoch ?? 0)) return false
  if (last.channel !== next.channel || last.overlap !== next.overlap || !sameSpeaker(last.speaker, next.speaker)) return false
  if (current.sourceSegments.some(isExplicitSpeakerCorrection) || isExplicitSpeakerCorrection(next)) return false

  const latestEnd = Math.max(...current.sourceSegments.map(segment => segment.endSample))
  return next.startSample <= latestEnd + MAX_DISPLAY_CONTINUITY_GAP_SAMPLES
}

/**
 * Coalesce only clear, time-adjacent ASR expansions for the live renderer.
 * The canonical `segments` array remains unchanged, including its segment
 * IDs, revisions, correction evidence, speaker boundaries, and overlap data.
 */
export function projectTranscriptDisplayEntries(segments: readonly TranscriptSegment[]): TranscriptDisplayEntry[] {
  const projected: TranscriptDisplayEntry[] = []
  // Old persisted notes can predate the main-process suppression upsert. Hide
  // only the proven microphone copies in this projection; canonical records
  // remain available for serialization, revisions, and corrections.
  const suppressedMicSegmentIds = new Set(
    meetingEcho.findCrossChannelEchoSuppressions(segments).suppressedMicSegmentIds,
  )
  const displaySegments = segments.filter(segment => !suppressedMicSegmentIds.has(segment.segmentId))

  for (const segment of [...displaySegments].sort(compareSegments)) {
    // A genuine simultaneous turn from the other channel must stay visible,
    // but it must not split one readable system turn into several fragments.
    const current = [...projected].reverse().find(entry => entry.channel === segment.channel)
    if (!current || !canJoinDisplayEntry(current, segment)) {
      projected.push({
        sourceSegments: [segment],
        text: segment.text,
        channel: segment.channel,
        speaker: segment.speaker,
        overlap: segment.overlap,
        finality: segment.finality,
      })
      continue
    }

    const latestEnd = Math.max(...current.sourceSegments.map(source => source.endSample))
    // Contiguous chunks are one turn and are joined verbatim. We remove
    // repeated words only if their audio intervals overlap as well as their
    // token text; adjacent chunks that merely happen to repeat a word keep it.
    const joined = segment.startSample < latestEnd
      ? joinOverlappingTranscriptText(current.text, segment.text, true)
      : null

    const sourceSegments = [...current.sourceSegments, segment]
    current.sourceSegments = sourceSegments
    current.text = joined ?? `${current.text.trimEnd()} ${segment.text.trimStart()}`.trim()
    current.finality = displayFinality(sourceSegments)
  }

  return projected
}

/**
 * `(segmentId, revision)` is idempotent.  Lower/equal revisions are ignored,
 * which makes duplicate/reordered bridge deliveries safe.
 */
export function upsertTranscriptSegments(
  existing: TranscriptSegment[],
  incoming: TranscriptSegment[],
): TranscriptSegment[] {
  const byId = new Map(existing.map(segment => [segment.segmentId, segment]))
  let changed = false

  // A stable/final segment can replace an earlier interim under a different
  // ID. Apply these tombstones before upserting so a retry is idempotent and
  // an interim/stable pair delivered in one event cannot render twice.
  const supersededIds = new Set(incoming.flatMap(segment => segment.supersedes ?? []))
  for (const segmentId of supersededIds) {
    if (byId.delete(segmentId)) changed = true
  }

  for (const segment of incoming) {
    if (supersededIds.has(segment.segmentId)) continue
    const current = byId.get(segment.segmentId)
    if (!current || segment.revision > current.revision) {
      byId.set(segment.segmentId, segment)
      changed = true
    }
  }

  return changed ? [...byId.values()].sort(compareSegments) : existing
}

export function removeTranscriptSegment(existing: TranscriptSegment[], segmentId: string): TranscriptSegment[] {
  const next = existing.filter(segment => segment.segmentId !== segmentId)
  return next.length === existing.length ? existing : next
}

export function transcriptProjection(segments: TranscriptSegment[]): string {
  return projectTranscriptDisplayEntries(segments)
    .filter(entry => entry.text.trim())
    .map(entry => {
      const overlap = entry.overlap ? ' [overlap]' : ''
      return `**${entry.speaker.displayName}:**${overlap} ${entry.text}`
    })
    .join('\n\n')
}

export function createTranscriptV2Block(segments: TranscriptSegment[]): TranscriptV2Block {
  const ordered = [...segments].sort(compareSegments)
  return {
    version: TRANSCRIPT_V2_VERSION,
    transcript: transcriptProjection(ordered),
    segments: ordered,
  }
}

/** Apply bridge-confirmed corrections without changing user-authored note text. */
export function applyTranscriptSegmentRevisions(
  block: TranscriptV2Block,
  revisions: TranscriptSegment[],
): TranscriptV2Block {
  return createTranscriptV2Block(upsertTranscriptSegments(block.segments, revisions))
}

type TranscriptRevisionListener = (segments: TranscriptSegment[]) => void
const revisionListeners = new Set<TranscriptRevisionListener>()

/**
 * NodeViews do not share React state with the recording hook. Publish a
 * confirmed correction through this renderer-local seam so the hook's next
 * document write cannot revert the visible higher revision.
 */
export function publishTranscriptSegmentRevisions(segments: TranscriptSegment[]): void {
  for (const listener of [...revisionListeners]) listener(segments)
}

export function subscribeTranscriptSegmentRevisions(listener: TranscriptRevisionListener): () => void {
  revisionListeners.add(listener)
  return () => revisionListeners.delete(listener)
}

export function parseTranscriptV2Block(raw: string): TranscriptV2Block | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== TRANSCRIPT_V2_VERSION || !Array.isArray(parsed.segments)) return null
    const segments = upsertTranscriptSegments([], normalizeTranscriptSegments(parsed.segments))
    return createTranscriptV2Block(segments)
  } catch {
    return null
  }
}

export function serializeTranscriptV2Block(block: TranscriptV2Block): string {
  return `\`\`\`${TRANSCRIPT_V2_FENCE}\n${JSON.stringify(block)}\n\`\`\``
}

const OWNED_TRANSCRIPT_BLOCK = /^```transcript-v2[ \t]*\n[\s\S]*?^```[ \t]*$/m

/**
 * Change only the explicitly owned v2 fence.  If a person deleted it, fail
 * closed rather than recreating a block in an arbitrary place in their note.
 */
export function replaceOwnedTranscriptV2Block(markdown: string, block: TranscriptV2Block): string | null {
  if (!OWNED_TRANSCRIPT_BLOCK.test(markdown)) return null
  return markdown.replace(OWNED_TRANSCRIPT_BLOCK, serializeTranscriptV2Block(block))
}

export function renderNewMeetingNote(
  header: string,
  block: TranscriptV2Block,
): string {
  return `${header.trimEnd()}\n\n${serializeTranscriptV2Block(block)}\n`
}
