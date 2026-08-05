import { describe, expect, it } from 'vitest'
import {
  mergeWisprMeetingArtifact,
  WISPR_ARTIFACT_END,
  WISPR_ARTIFACT_START,
} from './wispr-meeting-artifact'

const source = `---
type: meeting
source: wispr-flow
title: Meeting Notes
date: "2026-08-06T00:00:00.000Z"
---

# Meeting Notes

Scratchpad text written during the call.

<!-- rowboat:transcript-v2:start -->
{"version":2,"segments":[]}
<!-- rowboat:transcript-v2:end -->
`

describe('mergeWisprMeetingArtifact', () => {
  it('imports Wispr output without touching the transcript or scratchpad', () => {
    const result = mergeWisprMeetingArtifact(source, {
      meetingId: 'wispr-1',
      title: '  Product   review  ',
      notes: 'Remember the onboarding concern.',
      summary: 'The team agreed to ship the smaller scope.',
      participantNames: ['Rahul Khatri', 'Akbar'],
      finalized: true,
    })

    expect(result.title).toBe('Product review')
    expect(result.content).toContain('title: "Product review"')
    expect(result.content).toContain('# Product review')
    expect(result.content).toContain('## Summary\n\nThe team agreed to ship the smaller scope.')
    expect(result.content).toContain('## My thoughts\n\nRemember the onboarding concern.')
    expect(result.content).toContain('## Participants\n\n- Rahul Khatri\n- Akbar')
    expect(result.content).toContain('Scratchpad text written during the call.')
    expect(result.content).toContain('<!-- rowboat:transcript-v2:start -->')
  })

  it('reconciles its owned block idempotently when Wispr revises the result', () => {
    const first = mergeWisprMeetingArtifact(source, {
      meetingId: 'wispr-1',
      summary: 'First summary',
      participantNames: [],
      finalized: false,
    }).content
    const second = mergeWisprMeetingArtifact(first, {
      meetingId: 'wispr-1',
      summary: 'Final summary',
      participantNames: [],
      finalized: true,
    }).content

    expect(second.match(new RegExp(WISPR_ARTIFACT_START, 'g'))).toHaveLength(1)
    expect(second.match(new RegExp(WISPR_ARTIFACT_END, 'g'))).toHaveLength(1)
    expect(second).not.toContain('First summary')
    expect(second).toContain('Final summary')
  })
})
