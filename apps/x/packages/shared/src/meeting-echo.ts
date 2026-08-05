export type EchoTranscriptSegment = {
  meetingId?: string
  segmentId: string
  revision: number
  epoch?: number
  startSample: number
  endSample: number
  channel: 'mic' | 'system'
  text: string
  finality: 'interim' | 'stable' | 'final'
  overlap: boolean
  speaker: { kind: string }
  attributionSource?: string
  supersedes?: string[]
}

export type CrossChannelEchoSuppression<T extends EchoTranscriptSegment> = {
  suppressedMicSegmentIds: string[]
  systemUpserts: T[]
}

const ECHO_MIN_TOKENS = 5
const ECHO_MIN_NORMALIZED_CHARS = 24
const ECHO_MAX_TOKEN_EDITS = 1
const ECHO_MAX_BOUNDARY_DELTA_SAMPLES = 1_600
const ECHO_MIN_SHORTER_INTERVAL_OVERLAP = 0.9
const ECHO_RUN_MIN_PAIRS = 3
const ECHO_RUN_MIN_TOKENS = 8
const ECHO_RUN_MIN_NORMALIZED_CHARS = 24
const ECHO_RUN_MAX_NORMALIZED_EDIT_RATIO = 0.3
const ECHO_SPLIT_MAX_SEGMENTS = 4
const ECHO_SPLIT_MIN_TOKENS = 3
const ECHO_SPLIT_MIN_NORMALIZED_CHARS = 12

function echoTokens(text: string): string[] {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function boundedEditDistance<T>(left: readonly T[], right: readonly T[], limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const next = [leftIndex]
    let rowMinimum = next[0]!
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
      const value = Math.min(
        previous[rightIndex]! + 1,
        next[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + cost,
      )
      next.push(value)
      rowMinimum = Math.min(rowMinimum, value)
    }
    if (rowMinimum > limit) return limit + 1
    previous = next
  }
  return previous[right.length]!
}

function hasStrongEchoTextMatch(mic: EchoTranscriptSegment, system: EchoTranscriptSegment): boolean {
  const micTokens = echoTokens(mic.text)
  const systemTokens = echoTokens(system.text)
  const micNormalized = micTokens.join('')
  const systemNormalized = systemTokens.join('')
  if (
    micTokens.length < ECHO_MIN_TOKENS
    || systemTokens.length < ECHO_MIN_TOKENS
    || Math.min(micNormalized.length, systemNormalized.length) < ECHO_MIN_NORMALIZED_CHARS
  ) return false
  if (micNormalized === systemNormalized) return true
  return boundedEditDistance(micTokens, systemTokens, ECHO_MAX_TOKEN_EDITS) <= ECHO_MAX_TOKEN_EDITS
}

function hasRunEchoTextMatch(mic: EchoTranscriptSegment, system: EchoTranscriptSegment): boolean {
  const micTokens = echoTokens(mic.text)
  const systemTokens = echoTokens(system.text)
  const micNormalized = micTokens.join('')
  const systemNormalized = systemTokens.join('')
  if (!micNormalized || !systemNormalized) return false
  if (micNormalized === systemNormalized) return true
  if (
    Math.min(micTokens.length, systemTokens.length) >= 2
    && boundedEditDistance(micTokens, systemTokens, ECHO_MAX_TOKEN_EDITS) <= ECHO_MAX_TOKEN_EDITS
  ) return true
  const longest = Math.max(micNormalized.length, systemNormalized.length)
  if (Math.min(micNormalized.length, systemNormalized.length) < 6) return false
  const limit = Math.max(1, Math.floor(longest * ECHO_RUN_MAX_NORMALIZED_EDIT_RATIO))
  return boundedEditDistance([...micNormalized], [...systemNormalized], limit) <= limit
}

function hasSplitEchoTextMatch(mic: EchoTranscriptSegment, system: EchoTranscriptSegment): boolean {
  if (!hasRunEchoTextMatch(mic, system)) return false
  if (hasStrongEchoTextMatch(mic, system)) return true
  const tokenEvidence = Math.min(echoTokens(mic.text).length, echoTokens(system.text).length)
  const characterEvidence = Math.min(
    echoTokens(mic.text).join('').length,
    echoTokens(system.text).join('').length,
  )
  return tokenEvidence >= ECHO_SPLIT_MIN_TOKENS
    && characterEvidence >= ECHO_SPLIT_MIN_NORMALIZED_CHARS
}

function hasStrongEchoTimingMatch(mic: EchoTranscriptSegment, system: EchoTranscriptSegment): boolean {
  if (mic.meetingId !== system.meetingId || (mic.epoch ?? 0) !== (system.epoch ?? 0)) return false
  const micDuration = mic.endSample - mic.startSample
  const systemDuration = system.endSample - system.startSample
  if (micDuration <= 0 || systemDuration <= 0) return false
  if (
    Math.abs(mic.startSample - system.startSample) > ECHO_MAX_BOUNDARY_DELTA_SAMPLES
    || Math.abs(mic.endSample - system.endSample) > ECHO_MAX_BOUNDARY_DELTA_SAMPLES
  ) return false
  const overlap = Math.max(0, Math.min(mic.endSample, system.endSample) - Math.max(mic.startSample, system.startSample))
  return overlap / Math.min(micDuration, systemDuration) >= ECHO_MIN_SHORTER_INTERVAL_OVERLAP
}

function isEligibleMicEchoCandidate(segment: EchoTranscriptSegment): boolean {
  return segment.channel === 'mic'
    && segment.finality !== 'interim'
    && segment.overlap === false
    && (
      segment.speaker.kind === 'unknown'
      || (segment.speaker.kind === 'self' && segment.attributionSource === 'qualified-mic')
    )
}

function isEligibleSystemEchoCandidate(segment: EchoTranscriptSegment): boolean {
  return segment.channel === 'system'
    && segment.finality !== 'interim'
    && segment.overlap === false
}

function aggregateEchoSegments<T extends EchoTranscriptSegment>(segments: readonly T[]): T {
  const first = segments[0]!
  const last = segments[segments.length - 1]!
  return {
    ...first,
    endSample: last.endSample,
    text: segments.map(segment => segment.text).join(' '),
  }
}

function splitCandidatesCovering<T extends EchoTranscriptSegment>(
  target: T,
  candidates: readonly T[],
): T[][] {
  const ordered = [...candidates].sort((left, right) => (
    left.startSample - right.startSample || left.endSample - right.endSample || left.segmentId.localeCompare(right.segmentId)
  ))
  const matches: T[][] = []
  for (let start = 0; start < ordered.length; start++) {
    for (let length = 2; length <= ECHO_SPLIT_MAX_SEGMENTS && start + length <= ordered.length; length++) {
      const slice = ordered.slice(start, start + length)
      if (slice.some(segment => segment.meetingId !== target.meetingId || (segment.epoch ?? 0) !== (target.epoch ?? 0))) continue
      if (slice.some((segment, index) => (
        index > 0 && Math.abs(segment.startSample - slice[index - 1]!.endSample) > ECHO_MAX_BOUNDARY_DELTA_SAMPLES
      ))) continue
      const aggregate = aggregateEchoSegments(slice)
      if (!hasStrongEchoTimingMatch(target, aggregate)) continue
      if (target.channel === 'mic'
        ? hasSplitEchoTextMatch(target, aggregate)
        : hasSplitEchoTextMatch(aggregate, target)) matches.push(slice)
    }
  }
  return matches
}

/**
 * Collapse only one-to-one or uniquely covered, time-aligned mic copies of
 * system speech. A lone short/common match and materially different
 * simultaneous speech remain untouched.
 */
export function findCrossChannelEchoSuppressions<T extends EchoTranscriptSegment>(
  segments: Iterable<T>,
): CrossChannelEchoSuppression<T> {
  const all = [...segments]
  const mics = all.filter(isEligibleMicEchoCandidate)
  const systems = all.filter(isEligibleSystemEchoCandidate)
  const matchesByMic = new Map<string, T[]>()
  const matchesBySystem = new Map<string, T[]>()
  const strongPairs = new Set<string>()

  for (const mic of mics) {
    const matches = systems.filter(system => (
      hasStrongEchoTimingMatch(mic, system) && hasRunEchoTextMatch(mic, system)
    ))
    matchesByMic.set(mic.segmentId, matches)
    for (const system of matches) {
      if (hasStrongEchoTextMatch(mic, system)) strongPairs.add(`${mic.segmentId}\u0000${system.segmentId}`)
      const candidates = matchesBySystem.get(system.segmentId) ?? []
      candidates.push(mic)
      matchesBySystem.set(system.segmentId, candidates)
    }
  }

  type EchoPair = { mic: T; system: T; strong: boolean }
  const uniquePairs: EchoPair[] = []
  for (const mic of mics) {
    const [system] = matchesByMic.get(mic.segmentId) ?? []
    if (!system || (matchesByMic.get(mic.segmentId)?.length ?? 0) !== 1) continue
    if ((matchesBySystem.get(system.segmentId)?.length ?? 0) !== 1) continue
    uniquePairs.push({
      mic,
      system,
      strong: strongPairs.has(`${mic.segmentId}\u0000${system.segmentId}`),
    })
  }
  uniquePairs.sort((left, right) => (
    (left.mic.epoch ?? 0) - (right.mic.epoch ?? 0)
    || left.mic.startSample - right.mic.startSample
    || left.mic.segmentId.localeCompare(right.mic.segmentId)
  ))

  const acceptedPairs: EchoPair[] = []
  for (let start = 0; start < uniquePairs.length;) {
    let end = start + 1
    while (end < uniquePairs.length) {
      const previous = uniquePairs[end - 1]!
      const next = uniquePairs[end]!
      const contiguous = previous.mic.meetingId === next.mic.meetingId
        && (previous.mic.epoch ?? 0) === (next.mic.epoch ?? 0)
        && Math.abs(next.mic.startSample - previous.mic.endSample) <= ECHO_MAX_BOUNDARY_DELTA_SAMPLES
        && Math.abs(next.system.startSample - previous.system.endSample) <= ECHO_MAX_BOUNDARY_DELTA_SAMPLES
      if (!contiguous) break
      end += 1
    }
    const run = uniquePairs.slice(start, end)
    const tokenEvidence = run.reduce((total, pair) => (
      total + Math.min(echoTokens(pair.mic.text).length, echoTokens(pair.system.text).length)
    ), 0)
    const characterEvidence = run.reduce((total, pair) => (
      total + Math.min(echoTokens(pair.mic.text).join('').length, echoTokens(pair.system.text).join('').length)
    ), 0)
    if (
      run.some(pair => pair.strong)
      || (
        run.length >= ECHO_RUN_MIN_PAIRS
        && tokenEvidence >= ECHO_RUN_MIN_TOKENS
        && characterEvidence >= ECHO_RUN_MIN_NORMALIZED_CHARS
      )
    ) acceptedPairs.push(...run)
    start = end
  }

  const suppressedMicSegmentIds: string[] = []
  const suppressedBySystem = new Map<string, string[]>()
  const addSuppression = (systemId: string, micIds: readonly string[]): void => {
    for (const micId of micIds) {
      if (!suppressedMicSegmentIds.includes(micId)) suppressedMicSegmentIds.push(micId)
    }
    const current = suppressedBySystem.get(systemId) ?? []
    suppressedBySystem.set(systemId, [...current, ...micIds.filter(micId => !current.includes(micId))])
  }
  for (const { mic, system } of acceptedPairs) addSuppression(system.segmentId, [mic.segmentId])

  const usedSystemIds = new Set(suppressedBySystem.keys())
  const remainingMics = mics.filter(mic => !suppressedMicSegmentIds.includes(mic.segmentId))
  const remainingSystems = systems.filter(system => !usedSystemIds.has(system.segmentId))
  const systemGroupsByMic = new Map<string, T[][]>()
  const splitSystemUse = new Map<string, number>()
  for (const mic of remainingMics) {
    const groups = splitCandidatesCovering(mic, remainingSystems)
    systemGroupsByMic.set(mic.segmentId, groups)
    for (const group of groups) {
      for (const system of group) splitSystemUse.set(system.segmentId, (splitSystemUse.get(system.segmentId) ?? 0) + 1)
    }
  }
  for (const mic of remainingMics) {
    const [group] = systemGroupsByMic.get(mic.segmentId) ?? []
    if (!group || (systemGroupsByMic.get(mic.segmentId)?.length ?? 0) !== 1) continue
    if (group.some(system => splitSystemUse.get(system.segmentId) !== 1)) continue
    addSuppression(group[group.length - 1]!.segmentId, [mic.segmentId])
    for (const system of group) usedSystemIds.add(system.segmentId)
  }

  const stillRemainingMics = mics.filter(mic => !suppressedMicSegmentIds.includes(mic.segmentId))
  const stillRemainingSystems = systems.filter(system => !usedSystemIds.has(system.segmentId))
  const micGroupsBySystem = new Map<string, T[][]>()
  const splitMicUse = new Map<string, number>()
  for (const system of stillRemainingSystems) {
    const groups = splitCandidatesCovering(system, stillRemainingMics)
    micGroupsBySystem.set(system.segmentId, groups)
    for (const group of groups) {
      for (const mic of group) splitMicUse.set(mic.segmentId, (splitMicUse.get(mic.segmentId) ?? 0) + 1)
    }
  }
  for (const system of stillRemainingSystems) {
    const [group] = micGroupsBySystem.get(system.segmentId) ?? []
    if (!group || (micGroupsBySystem.get(system.segmentId)?.length ?? 0) !== 1) continue
    if (group.some(mic => splitMicUse.get(mic.segmentId) !== 1)) continue
    addSuppression(system.segmentId, group.map(mic => mic.segmentId))
  }

  const systemUpserts = [...suppressedBySystem.entries()]
    .map(([systemId, micIds]) => {
      const system = systems.find(candidate => candidate.segmentId === systemId)!
      return {
        ...system,
        revision: system.revision + 1,
        supersedes: [...new Set([...(system.supersedes ?? []), ...micIds])].sort(),
      } as T
    })
    .sort((left, right) => left.segmentId.localeCompare(right.segmentId))

  return { suppressedMicSegmentIds: suppressedMicSegmentIds.sort(), systemUpserts }
}
