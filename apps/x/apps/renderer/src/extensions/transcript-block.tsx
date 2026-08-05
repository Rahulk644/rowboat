import { mergeAttributes, Node } from '@tiptap/react'
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react'
import { Check, ChevronDown, FileText, Pencil, X } from 'lucide-react'
import { blocks } from '@x/shared'
import { useMemo, useState } from 'react'
import {
  applyTranscriptSegmentRevisions,
  createSpeakerCorrectionRequests,
  normalizeTranscriptSegments,
  parseTranscriptV2Block,
  projectTranscriptDisplayEntries,
  publishTranscriptSegmentRevisions,
  type SpeakerCorrectionRequest,
  type TranscriptFinality,
  type TranscriptSegment,
  type TranscriptSpeaker,
} from '@/lib/meeting-transcript-v2'

interface TranscriptEntry {
  segmentId?: string
  meetingId?: string
  speaker: TranscriptSpeaker
  text: string
  overlap: boolean
  finality: TranscriptFinality
  /** The raw canonical segments behind a renderer-only grouped turn. */
  sourceSegments?: TranscriptSegment[]
}

function parseLegacyTranscript(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  const lines = raw.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = trimmed.match(/^\*\*(.+?):\*\*\s*(.*)$/)
    if (match) {
      entries.push({
        speaker: { kind: 'unknown', displayName: match[1] },
        text: match[2],
        overlap: false,
        finality: 'final',
      })
    } else if (entries.length > 0) {
      entries[entries.length - 1].text += ` ${trimmed}`
    }
  }
  return entries
}

function parseTranscript(raw: string): TranscriptEntry[] {
  const v2 = parseTranscriptV2Block(raw)
  if (v2) {
    return projectTranscriptDisplayEntries(v2.segments).map(entry => ({
      // A grouped turn retains every raw segment for exact correction IPC.
      segmentId: entry.sourceSegments[0]?.segmentId,
      meetingId: entry.sourceSegments[0]?.meetingId,
      speaker: entry.speaker,
      text: entry.text,
      overlap: entry.overlap,
      finality: entry.finality,
      sourceSegments: entry.sourceSegments,
    }))
  }

  try {
    const legacy = blocks.TranscriptBlockSchema.parse(JSON.parse(raw))
    return parseLegacyTranscript(legacy.transcript)
  } catch {
    return []
  }
}

function speakerColor(speaker: string): string {
  let hash = 0
  for (let i = 0; i < speaker.length; i++) {
    hash = speaker.charCodeAt(i) + ((hash << 5) - hash)
  }
  const colors = ['#3b82f6', '#06b6d4', '#6366f1', '#8b5cf6', '#0ea5e9', '#2563eb', '#7c3aed']
  return colors[Math.abs(hash) % colors.length]
}

/**
 * The renderer has no identity authority. This narrow IPC boundary submits a
 * meeting-local correction to the bridge, which records the evidence and may
 * return a higher segment revision. The optional profile checkbox remains off
 * until the person explicitly opts in.
 */
async function submitSpeakerCorrection(request: SpeakerCorrectionRequest): Promise<unknown> {
  type CorrectionIpc = {
    invoke(channel: 'meeting:transcription:correctSpeaker', args: SpeakerCorrectionRequest): Promise<unknown>
  }
  return (window.ipc as unknown as CorrectionIpc).invoke('meeting:transcription:correctSpeaker', request)
}

function correctionSegments(value: unknown) {
  const direct = normalizeTranscriptSegments(value)
  if (direct.length > 0) return direct
  if (typeof value === 'object' && value !== null && 'segment' in value) {
    return normalizeTranscriptSegments((value as { segment: unknown }).segment)
  }
  return []
}

function TranscriptBlockView({ node, getPos, editor, updateAttributes }: {
  node: { attrs: Record<string, unknown> }
  getPos: () => number | undefined
  updateAttributes: (attrs: Record<string, unknown>) => void
  // TipTap's NodeView editor type is intentionally broad at this boundary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor: any
}) {
  const raw = node.attrs.data as string
  const entries = useMemo(() => parseTranscript(raw), [raw])
  const isV2 = useMemo(() => parseTranscriptV2Block(raw) !== null, [raw])

  const isFirstBlock = useMemo(() => {
    try {
      const pos = getPos()
      if (pos === undefined) return false
      const firstChild = editor?.state?.doc?.firstChild
      if (!firstChild) return true
      return pos <= (firstChild.nodeSize ?? 0) + 1
    } catch {
      return false
    }
  }, [getPos, editor])

  const [expanded, setExpanded] = useState(isFirstBlock)
  const [editingSegmentIds, setEditingSegmentIds] = useState<string[] | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [rememberVoice, setRememberVoice] = useState(false)
  const [correctionError, setCorrectionError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const startCorrection = (segments: readonly TranscriptSegment[]) => {
    const first = segments[0]
    if (!first) return
    setEditingSegmentIds(segments.map(segment => segment.segmentId))
    setDisplayName(first.speaker.displayName === 'Unknown speaker' ? '' : first.speaker.displayName)
    setRememberVoice(false)
    setCorrectionError(null)
  }

  const saveCorrection = async (segments: readonly TranscriptSegment[]) => {
    const nextName = displayName.trim()
    if (segments.length === 0 || !nextName) return
    setSaving(true)
    setCorrectionError(null)
    try {
      // A grouped display turn has one verified speaker boundary. Correct
      // each canonical record together; durable voice enrollment is opt-in
      // and sent only once so one click cannot create duplicate enrollments.
      const responses = await Promise.all(
        createSpeakerCorrectionRequests(segments, nextName, rememberVoice).map(submitSpeakerCorrection),
      )
      const revised = responses.flatMap(correctionSegments)
      const current = parseTranscriptV2Block(raw)
      const revisedIds = new Set(revised.map(segment => segment.segmentId))
      if (!current || !segments.every(segment => revisedIds.has(segment.segmentId))) {
        throw new Error('The correction response did not include every revised transcript segment')
      }
      updateAttributes({
        data: JSON.stringify(applyTranscriptSegmentRevisions(current, revised)),
      })
      publishTranscriptSegmentRevisions(revised)
      setEditingSegmentIds(null)
    } catch {
      setCorrectionError('Could not save this correction yet.')
    } finally {
      setSaving(false)
    }
  }

  if (entries.length === 0 && !isV2) {
    return (
      <NodeViewWrapper className="transcript-block-wrapper" data-type="transcript-block">
        <div className="transcript-block-card transcript-block-error">
          <FileText size={16} />
          <span>Invalid transcript block</span>
        </div>
      </NodeViewWrapper>
    )
  }

  return (
    <NodeViewWrapper className="transcript-block-wrapper" data-type="transcript-block">
      <div className="transcript-block-card" onMouseDown={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="transcript-block-toggle"
          onClick={(event) => { event.stopPropagation(); setExpanded(!expanded) }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <ChevronDown size={14} className={`transcript-block-chevron ${expanded ? 'transcript-block-chevron-open' : ''}`} />
          <FileText size={14} />
          <span>Raw transcript</span>
        </button>
        {expanded && (
          <div className="transcript-block-content">
            {entries.length > 0 ? entries.map((entry, index) => {
              const correctionSegments = entry.sourceSegments ?? []
              const isEditing = correctionSegments.length > 0
                && correctionSegments.length === editingSegmentIds?.length
                && correctionSegments.every(segment => editingSegmentIds?.includes(segment.segmentId))
              return (
                <div
                  key={entry.segmentId ?? entry.sourceSegments?.map(segment => segment.segmentId).join(':') ?? `${entry.speaker.displayName}-${index}`}
                  className={`transcript-entry transcript-entry-${entry.finality}`}
                >
                  <div className="transcript-entry-meta">
                    <span className="transcript-speaker" style={{ color: speakerColor(entry.speaker.displayName) }}>
                      {entry.speaker.displayName}
                    </span>
                    {entry.overlap && <span className="transcript-overlap-badge">Overlapping speech</span>}
                    {entry.finality === 'interim' && <span className="transcript-interim-badge">Live</span>}
                    {correctionSegments.length > 0 && (
                      <button
                        type="button"
                        className="transcript-speaker-correct"
                        aria-label={correctionSegments.length === 1
                          ? `Correct speaker ${entry.speaker.displayName}`
                          : `Correct speaker ${entry.speaker.displayName} for all ${correctionSegments.length} source segments in this grouped turn`}
                        title={correctionSegments.length === 1
                          ? 'Correct speaker'
                          : `Corrects all ${correctionSegments.length} source segments in this grouped turn`}
                        onClick={() => startCorrection(correctionSegments)}
                      >
                        <Pencil size={12} />
                      </button>
                    )}
                  </div>
                  <span className="transcript-text">{entry.text}</span>
                  {isEditing && (
                    <form
                      className="transcript-speaker-correction"
                      onSubmit={(event) => { event.preventDefault(); void saveCorrection(correctionSegments) }}
                    >
                      <label>
                        Speaker name
                        <input
                          type="text"
                          autoFocus
                          value={displayName}
                          onChange={(event) => setDisplayName(event.target.value)}
                          placeholder="Name this speaker"
                        />
                      </label>
                      <label className="transcript-remember-voice">
                        <input
                          type="checkbox"
                          checked={rememberVoice}
                          onChange={(event) => setRememberVoice(event.target.checked)}
                        />
                        Remember this voice for future meetings (stores a voice embedding)
                      </label>
                      {correctionError && <span className="transcript-correction-error">{correctionError}</span>}
                      <div className="transcript-correction-actions">
                        <button type="submit" disabled={!displayName.trim() || saving}>
                          <Check size={13} /> Save for this meeting
                        </button>
                        <button type="button" onClick={() => setEditingSegmentIds(null)} disabled={saving}>
                          <X size={13} /> Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              )
            }) : (
              <div className="transcript-raw">Waiting for the first transcript segment…</div>
            )}
          </div>
        )}
      </div>
    </NodeViewWrapper>
  )
}

export const TranscriptBlockExtension = Node.create({
  name: 'transcriptBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return { data: { default: '{}' } }
  },

  parseHTML() {
    return [{
      tag: 'pre',
      priority: 60,
      getAttrs(element) {
        const code = element.querySelector('code')
        if (!code) return false
        const cls = code.className || ''
        if (cls.includes('language-transcript-v2') || cls.includes('language-transcript')) {
          return { data: code.textContent || '{}' }
        }
        return false
      },
    }]
  },

  renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'transcript-block' })]
  },

  addNodeView() {
    return ReactNodeViewRenderer(TranscriptBlockView)
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: { write: (text: string) => void; closeBlock: (node: unknown) => void }, node: { attrs: { data: string } }) {
          const isV2 = parseTranscriptV2Block(node.attrs.data) !== null
          state.write(`\`\`\`${isV2 ? 'transcript-v2' : 'transcript'}\n${node.attrs.data}\n\`\`\``)
          state.closeBlock(node)
        },
        parse: {},
      },
    }
  },
})
