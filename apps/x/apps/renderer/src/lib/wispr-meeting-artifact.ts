export type WisprMeetingArtifact = {
  meetingId: string
  title?: string
  notes?: string
  summary?: string
  participantNames: string[]
  finalized: boolean
  endedAt?: string | number
}

export const WISPR_ARTIFACT_START = '<!-- rowboat:wispr-artifact:start -->'
export const WISPR_ARTIFACT_END = '<!-- rowboat:wispr-artifact:end -->'

function normalizedTitle(value: string | undefined): string | undefined {
  const title = value?.replace(/\s+/g, ' ').trim().slice(0, 255)
  return title || undefined
}

function renderWisprArtifact(artifact: WisprMeetingArtifact): string {
  const sections = [WISPR_ARTIFACT_START]
  if (artifact.summary?.trim()) sections.push('', '## Summary', '', artifact.summary.trim())
  if (artifact.notes?.trim()) sections.push('', '## My thoughts', '', artifact.notes.trim())
  if (artifact.participantNames.length > 0) {
    sections.push('', '## Participants', '', artifact.participantNames.map(name => `- ${name}`).join('\n'))
  }
  sections.push('', WISPR_ARTIFACT_END)
  return sections.join('\n')
}

function replaceMeetingTitle(content: string, title: string | undefined): string {
  if (!title) return content
  const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0]
  let updated = content
  if (frontmatter) {
    const nextFrontmatter = /^title:\s*.*$/m.test(frontmatter)
      ? frontmatter.replace(/^title:\s*.*$/m, `title: ${JSON.stringify(title)}`)
      : frontmatter.replace(/\r?\n---(?:\r?\n|$)$/, `\ntitle: ${JSON.stringify(title)}\n---\n`)
    updated = `${nextFrontmatter}${content.slice(frontmatter.length)}`
  }

  const bodyStart = updated.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0].length ?? 0
  const body = updated.slice(bodyStart)
  const heading = body.match(/^#\s+[^\n]*$/m)
  if (!heading || heading.index === undefined) return updated
  const headingStart = bodyStart + heading.index
  return `${updated.slice(0, headingStart)}# ${title}${updated.slice(headingStart + heading[0].length)}`
}

/**
 * Merge only the block owned by the Wispr connector and the note's canonical
 * title. The transcript and any scratchpad text remain independently owned.
 */
export function mergeWisprMeetingArtifact(
  content: string,
  artifact: WisprMeetingArtifact,
): { content: string; title?: string } {
  const title = normalizedTitle(artifact.title)
  const titledContent = replaceMeetingTitle(content, title)
  const block = renderWisprArtifact(artifact)
  const start = titledContent.indexOf(WISPR_ARTIFACT_START)
  const end = titledContent.indexOf(WISPR_ARTIFACT_END)
  const merged = start >= 0 && end >= start
    ? `${titledContent.slice(0, start)}${block}${titledContent.slice(end + WISPR_ARTIFACT_END.length)}`
    : `${titledContent.trimEnd()}\n\n${block}\n`
  return { content: merged, ...(title ? { title } : {}) }
}
