import { describe, expect, it } from 'vitest'
import {
  applyTranscriptSegmentRevisions,
  createTranscriptV2Block,
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
})
