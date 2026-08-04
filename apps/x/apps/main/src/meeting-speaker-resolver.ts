import type {
  MeetingCaptureHealth,
  MeetingTranscriptSegment,
  MeetingTranscriptSpeaker,
} from './meeting-transcription.js';

/** Sources that can assert an active participant, not merely a roster entry. */
export type TrustedMeetingEvidenceSource =
  | 'zoom_ax'
  | 'meet_ax'
  | 'teams_ax'
  | 'slack_ax'
  | 'webex_ax'
  | 'browser_extension';

export type MeetingSpeakerEvidence = {
  source: TrustedMeetingEvidenceSource | string;
  participantId?: string;
  displayName?: string;
  isSelf?: boolean;
  isActive?: boolean;
  isMuted?: boolean;
  startSample: number;
  endSample: number;
  confidence: number;
};

export type ConfirmedVoiceProfileMatch = {
  profileId: string;
  displayName: string;
  confirmed: boolean;
  similarity: number;
  minimumSimilarity: number;
  runnerUpSimilarity?: number;
  minimumMargin: number;
};

export type MeetingSpeakerCorrection = {
  displayName: string;
};

export type SpeakerResolutionInput = {
  correction?: MeetingSpeakerCorrection;
  micHealth?: MeetingCaptureHealth;
  /** A qualified render reference makes a clean microphone attribution safe. */
  playbackReferenceHealthy?: boolean;
  /** A qualified wired/headphone route can also prove acoustic isolation. */
  outputRouteIsolated?: boolean;
  /** Only use this narrow escape hatch for measured playback leakage. */
  micLeakSuspected?: boolean;
  evidence?: MeetingSpeakerEvidence[];
  voiceProfile?: ConfirmedVoiceProfileMatch;
  stableClusterIds?: string[];
};

export type SpeakerResolution = {
  speaker: MeetingTranscriptSpeaker;
  clusterIds: string[];
  overlap: boolean;
  attributionSource: string;
  attributionConfidence: number;
};

const TRUSTED_ACTIVE_SOURCES = new Set<TrustedMeetingEvidenceSource>([
  'zoom_ax', 'meet_ax', 'teams_ax', 'slack_ax', 'webex_ax', 'browser_extension',
]);
const MIN_ACTIVE_OVERLAP_SAMPLES = 3_200; // 200 ms at the canonical 16 kHz meeting clock.
const DOMINANCE_RATIO = 1.25;

function cleanName(value: string | undefined): string | undefined {
  const name = value?.trim();
  if (!name) return undefined;
  const generic = name.toLocaleLowerCase();
  if (generic === 'you' || generic === 'unknown' || generic === 'unknown speaker' || generic === 'participant') {
    return undefined;
  }
  return name;
}

function overlapSamples(segment: MeetingTranscriptSegment, evidence: MeetingSpeakerEvidence): number {
  return Math.max(0, Math.min(segment.endSample, evidence.endSample) - Math.max(segment.startSample, evidence.startSample));
}

function sameSpeaker(left: MeetingTranscriptSpeaker, right: MeetingTranscriptSpeaker): boolean {
  return left.kind === right.kind && left.id === right.id && left.displayName === right.displayName;
}

function isQualifiedMic(segment: MeetingTranscriptSegment, input: SpeakerResolutionInput): boolean {
  if (segment.channel !== 'mic') return false;
  if (input.micHealth?.state !== 'ready') return false;
  return input.playbackReferenceHealthy === true || input.outputRouteIsolated === true;
}

type ActiveCandidate = {
  id: string;
  name: string;
  coverage: number;
  weightedCoverage: number;
  maxConfidence: number;
  sources: Set<string>;
  ranges: Array<{ start: number; end: number; confidence: number }>;
};

function activeCandidates(segment: MeetingTranscriptSegment, evidence: readonly MeetingSpeakerEvidence[]): ActiveCandidate[] {
  const byParticipant = new Map<string, ActiveCandidate>();
  for (const item of evidence) {
    const name = cleanName(item.displayName);
    const duration = overlapSamples(segment, item);
    if (!name || !item.isActive || item.isMuted || duration === 0 || !TRUSTED_ACTIVE_SOURCES.has(item.source as TrustedMeetingEvidenceSource)) continue;
    const id = item.participantId?.trim() || `name:${name.toLocaleLowerCase()}`;
    const candidate = byParticipant.get(id) ?? {
      id, name, coverage: 0, weightedCoverage: 0, maxConfidence: 0, sources: new Set<string>(), ranges: [],
    };
    candidate.ranges.push({
      start: Math.max(segment.startSample, item.startSample),
      end: Math.min(segment.endSample, item.endSample),
      confidence: Math.max(0, Math.min(1, item.confidence)),
    });
    candidate.maxConfidence = Math.max(candidate.maxConfidence, item.confidence);
    candidate.sources.add(item.source);
    byParticipant.set(id, candidate);
  }
  return [...byParticipant.values()].map((candidate) => {
    const ranges = [...candidate.ranges].sort((a, b) => a.start - b.start || b.confidence - a.confidence);
    let coverage = 0;
    let weightedCoverage = 0;
    let current: { start: number; end: number; confidence: number } | undefined;
    for (const range of ranges) {
      if (!current || range.start > current.end) {
        if (current) {
          coverage += current.end - current.start;
          weightedCoverage += (current.end - current.start) * current.confidence;
        }
        current = { ...range };
      } else {
        current.end = Math.max(current.end, range.end);
        current.confidence = Math.max(current.confidence, range.confidence);
      }
    }
    if (current) {
      coverage += current.end - current.start;
      weightedCoverage += (current.end - current.start) * current.confidence;
    }
    return { ...candidate, coverage, weightedCoverage };
  }).sort((a, b) => b.weightedCoverage - a.weightedCoverage || b.coverage - a.coverage || a.name.localeCompare(b.name));
}

function activeResolution(segment: MeetingTranscriptSegment, evidence: readonly MeetingSpeakerEvidence[]): SpeakerResolution | null {
  const candidates = activeCandidates(segment, evidence).filter((candidate) => candidate.coverage >= MIN_ACTIVE_OVERLAP_SAMPLES);
  if (!candidates.length) return null;
  const [winner, runnerUp] = candidates;
  if (!runnerUp || winner.weightedCoverage >= runnerUp.weightedCoverage * DOMINANCE_RATIO) {
    return {
      speaker: { kind: 'named', id: winner.id, displayName: winner.name },
      clusterIds: [], overlap: false,
      attributionSource: [...winner.sources].sort().join('+'),
      attributionConfidence: Math.max(0, Math.min(1, winner.maxConfidence)),
    };
  }
  // Do not arbitrarily choose a name during concurrent active-speaker
  // evidence. The two names remain visible in the resolution label while the
  // canonical speaker kind deliberately stays unknown.
  return {
    speaker: { kind: 'unknown', displayName: candidates.map((candidate) => candidate.name).join(' + ') },
    clusterIds: [], overlap: true,
    attributionSource: 'trusted-ax-overlap',
    attributionConfidence: Math.max(0, Math.min(1, winner.maxConfidence)),
  };
}

function confirmedVoiceResolution(match: ConfirmedVoiceProfileMatch | undefined): SpeakerResolution | null {
  if (!match?.confirmed || !cleanName(match.displayName)) return null;
  const runnerUp = match.runnerUpSimilarity ?? -1;
  if (match.similarity < match.minimumSimilarity || match.similarity - runnerUp < match.minimumMargin) return null;
  return {
    speaker: { kind: 'named', id: match.profileId, displayName: match.displayName.trim() },
    clusterIds: [], overlap: false,
    attributionSource: 'confirmed-voice-profile',
    attributionConfidence: Math.max(0, Math.min(1, match.similarity)),
  };
}

function stableClusterResolution(clusterIds: readonly string[]): SpeakerResolution | null {
  const unique = [...new Set(clusterIds.map((id) => id.trim()).filter(Boolean))];
  if (!unique.length) return null;
  if (unique.length > 1) {
    return {
      speaker: { kind: 'unknown', displayName: unique.join(' + ') },
      clusterIds: unique, overlap: true,
      attributionSource: 'stable-cluster-overlap', attributionConfidence: 0.5,
    };
  }
  return {
    speaker: { kind: 'cluster', id: unique[0], displayName: unique[0] },
    clusterIds: unique, overlap: false,
    attributionSource: 'stable-anonymous-cluster', attributionConfidence: 0.5,
  };
}

function unknownResolution(): SpeakerResolution {
  return {
    speaker: { kind: 'unknown', displayName: 'Unknown speaker' },
    clusterIds: [], overlap: false, attributionSource: 'unresolved', attributionConfidence: 0,
  };
}

/**
 * Resolve exactly one already-timestamped interval. Calendar, contacts, and
 * passive participant rosters are intentionally absent: they cannot name a
 * turn. Multiple active signals produce an overlap label instead of a guess.
 */
export function resolveMeetingSpeaker(segment: MeetingTranscriptSegment, input: SpeakerResolutionInput): SpeakerResolution {
  const correctionName = cleanName(input.correction?.displayName);
  if (correctionName) {
    return {
      speaker: { kind: 'named', id: `correction:${segment.segmentId}`, displayName: correctionName },
      clusterIds: [], overlap: false, attributionSource: 'explicit-user-correction', attributionConfidence: 1,
    };
  }

  const ax = activeResolution(segment, input.evidence ?? []);
  // A measured leaked-mic case is the one exception to the normal mic-first
  // order: direct, dominant remote AX evidence is safer than labelling remote
  // playback as the user.
  if (isQualifiedMic(segment, input) && !(input.micLeakSuspected && ax && !ax.overlap)) {
    return {
      speaker: { kind: 'self', id: 'self', displayName: 'You' },
      clusterIds: [], overlap: false, attributionSource: 'qualified-mic', attributionConfidence: 0.95,
    };
  }
  if (ax) return ax;

  const profile = confirmedVoiceResolution(input.voiceProfile);
  if (profile) return profile;
  return stableClusterResolution(input.stableClusterIds ?? []) ?? unknownResolution();
}

/**
 * Produces a canonical higher-revision upsert only when attribution differs.
 * Text, timing, and user-authored notes are never mutated here.
 */
export function resolveMeetingSpeakerUpsert(
  segment: MeetingTranscriptSegment,
  input: SpeakerResolutionInput,
): MeetingTranscriptSegment | null {
  const resolution = resolveMeetingSpeaker(segment, input);
  if (
    sameSpeaker(segment.speaker, resolution.speaker)
    && segment.overlap === resolution.overlap
    && segment.attributionSource === resolution.attributionSource
    && segment.attributionConfidence === resolution.attributionConfidence
    && segment.clusterIds.length === resolution.clusterIds.length
    && segment.clusterIds.every((value, index) => value === resolution.clusterIds[index])
  ) return null;
  return { ...segment, revision: segment.revision + 1, ...resolution };
}
