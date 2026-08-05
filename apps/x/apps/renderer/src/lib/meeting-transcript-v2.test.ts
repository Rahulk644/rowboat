import { describe, expect, it } from 'vitest'
import {
  applyTranscriptSegmentRevisions,
  createTranscriptV2Block,
  isCanonicalTranscriptSnapshot,
  normalizeTranscriptSegment,
  parseTranscriptV2Block,
  removeTranscriptSegment,
  replaceOwnedTranscriptV2Block,
  serializeTranscriptV2Block,
  upsertTranscriptSegments,
} from './meeting-transcript-v2'

const first = normalizeTranscriptSegment({
  meetingId: 'meeting-1',
  segmentId: 'system-1',
  revision: 1,
  startSample: 100,
  endSample: 200,
  timingConfidence: 'high',
  channel: 'system',
  text: 'Hello from Akbar',
  finality: 'stable',
  clusterIds: ['cluster-a'],
  overlap: false,
  speaker: { kind: 'named', id: 'akbar', displayName: 'Akbar' },
})!

describe('meeting transcript v2', () => {
  it('upserts only a higher segment revision and keeps the supplied speaker', () => {
    const stale = { ...first, revision: 0, text: 'stale text' }
    const revised = { ...first, revision: 2, text: 'Hello from Akbar, revised' }

    expect(upsertTranscriptSegments([first], [stale])).toEqual([first])
    expect(upsertTranscriptSegments([first], [revised])).toEqual([revised])
  })

  it('recognizes an empty canonical v2 delta so callers never replay legacy text', () => {
    expect(isCanonicalTranscriptSnapshot({ version: 2, segments: [], full: 'cumulative words' })).toBe(true)
    expect(isCanonicalTranscriptSnapshot({ segments: [] })).toBe(true)
    expect(isCanonicalTranscriptSnapshot({ full: 'legacy words', committed: 'legacy words' })).toBe(false)
  })

  it('never promotes an unlabeled microphone segment to You', () => {
    const segment = normalizeTranscriptSegment({
      segmentId: 'mic-1', revision: 1, startSample: 0, endSample: 10,
      channel: 'mic', text: 'A microphone sentence', finality: 'interim',
    })

    expect(segment?.speaker).toEqual({ kind: 'unknown', displayName: 'Unknown speaker' })
  })

  it('changes only the owned transcript fence and preserves user notes', () => {
    const block = createTranscriptV2Block([first])
    const original = `---\ntype: meeting\n---\n\n# Notes\n\nMy scratchpad stays put.\n\n${serializeTranscriptV2Block(createTranscriptV2Block([]))}\n\nA user conclusion stays too.\n`
    const merged = replaceOwnedTranscriptV2Block(original, block)

    expect(merged).toContain('My scratchpad stays put.')
    expect(merged).toContain('A user conclusion stays too.')
    expect(merged).toContain('Hello from Akbar')
    expect(serializeTranscriptV2Block(block)).toMatch(/^```transcript-v2\n/)
  })

  it('refuses to write into a note after the user removes the owned block', () => {
    expect(replaceOwnedTranscriptV2Block('# My note\n\nMy words', createTranscriptV2Block([first]))).toBeNull()
  })

  it('round trips structured overlap data and can remove an interim segment', () => {
    const overlap = { ...first, segmentId: 'system-overlap', overlap: true, revision: 3 }
    const block = createTranscriptV2Block([first, overlap])
    const parsed = parseTranscriptV2Block(JSON.stringify(block))

    expect(parsed?.segments).toHaveLength(2)
    expect(parsed?.segments[1]?.overlap).toBe(true)
    expect(removeTranscriptSegment(parsed!.segments, 'system-overlap')).toEqual([first])
  })

  it('applies a bridge-confirmed speaker correction immediately by higher revision', () => {
    const block = createTranscriptV2Block([first])
    const corrected = {
      ...first,
      revision: 2,
      speaker: { kind: 'named' as const, id: 'parminder', displayName: 'Parminder' },
    }

    expect(applyTranscriptSegmentRevisions(block, [corrected]).segments).toEqual([corrected])
    expect(applyTranscriptSegmentRevisions(block, [corrected]).transcript).toContain('Parminder')
  })

  it('replaces an Unknown speaker with a main-process name-only revision in the active note', () => {
    const provisional = {
      ...first,
      segmentId: 'system-zoom-1',
      revision: 4,
      text: 'The deployment is ready for review.',
      overlap: true,
      speaker: { kind: 'unknown' as const, displayName: 'Unknown speaker' },
      attributionSource: 'self-hosted-feed-window',
      attributionConfidence: 0,
    }
    // This models an AX/evidence-only upsert: timing, text, and segment ID
    // stay stable; the higher revision changes attribution only.
    const namedRevision = {
      ...provisional,
      revision: 5,
      speaker: { kind: 'named' as const, id: 'zoom:vikram', displayName: 'Vikram' },
      attributionSource: 'zoom_ax',
      attributionConfidence: 0.95,
    }
    const activeBlock = createTranscriptV2Block([provisional])
    const revisedBlock = applyTranscriptSegmentRevisions(activeBlock, [namedRevision])
    const activeNote = `# Live meeting\n\n${serializeTranscriptV2Block(activeBlock)}\n\nUser notes stay outside the fence.\n`
    const persistedNote = replaceOwnedTranscriptV2Block(activeNote, revisedBlock)
    const serialized = persistedNote?.match(/```transcript-v2\n([\s\S]*?)\n```/)?.[1]
    const restored = serialized ? parseTranscriptV2Block(serialized) : null

    expect(revisedBlock.segments).toEqual([namedRevision])
    expect(revisedBlock.transcript).toBe('**Vikram:** [overlap] The deployment is ready for review.')
    expect(restored?.segments).toEqual([namedRevision])
    expect(restored?.transcript).toBe('**Vikram:** [overlap] The deployment is ready for review.')
    expect(persistedNote).toContain('User notes stay outside the fence.')
    expect(persistedNote?.match(/"segmentId":"system-zoom-1"/g)).toHaveLength(1)
  })

  it('replaces a superseded interim without duplicate text, including on retry', () => {
    const interim = {
      ...first,
      segmentId: 'system-interim',
      revision: 4,
      finality: 'interim' as const,
      text: 'A partial sentence',
    }
    const stable = {
      ...first,
      segmentId: 'system-final',
      revision: 1,
      finality: 'stable' as const,
      text: 'A complete sentence',
      supersedes: ['system-interim'],
    }

    const firstDelivery = upsertTranscriptSegments([interim], [stable])
    expect(firstDelivery).toEqual([stable])
    expect(upsertTranscriptSegments(firstDelivery, [stable])).toEqual([stable])
    expect(upsertTranscriptSegments([], [interim, stable])).toEqual([stable])
  })

  it('keeps cumulative stable windows and revised provisional windows to one final projection', () => {
    const stable0 = {
      ...first,
      segmentId: 'system:e0:stable:0', revision: 0, startSample: 0, endSample: 16_000,
      text: 'this time', finality: 'stable' as const,
    }
    const provisional0 = {
      ...first,
      segmentId: 'system:e0:provisional:16000', revision: 0, startSample: 16_000, endSample: 16_000,
      text: 'taken you', finality: 'interim' as const,
    }
    const provisional0Revised = { ...provisional0, revision: 1, text: 'taken you are shown', endSample: 32_000 }
    const stable1 = {
      ...first,
      segmentId: 'system:e0:stable:16000', revision: 0, startSample: 16_000, endSample: 32_000,
      text: 'taken you', finality: 'stable' as const, supersedes: [provisional0.segmentId],
    }
    const provisional1 = {
      ...first,
      segmentId: 'system:e0:provisional:48000', revision: 0, startSample: 48_000, endSample: 48_000,
      text: 'are showing', finality: 'interim' as const,
    }
    const final0 = { ...stable0, revision: 1, finality: 'final' as const }
    const final1 = { ...stable1, revision: 1, finality: 'final' as const }
    const final2 = {
      ...first,
      segmentId: 'system:e0:stable:48000', revision: 0, startSample: 48_000, endSample: 64_000,
      text: 'are showing is this the av', finality: 'final' as const, supersedes: [provisional1.segmentId],
    }

    let segments = upsertTranscriptSegments([], [stable0, provisional0])
    segments = upsertTranscriptSegments(segments, [provisional0Revised])
    segments = upsertTranscriptSegments(segments, [stable1, provisional1])
    expect(segments.map(segment => segment.segmentId)).toEqual([
      stable0.segmentId, stable1.segmentId, provisional1.segmentId,
    ])

    const finalized = upsertTranscriptSegments(segments, [final0, final1, final2])
    expect(finalized).toEqual([final0, final1, final2])
    expect(createTranscriptV2Block(finalized).transcript).toContain('this time')
    expect(createTranscriptV2Block(finalized).transcript).not.toContain('taken you are shown')
    expect(upsertTranscriptSegments(finalized, [final0, final1, final2])).toEqual(finalized)
  })
})
