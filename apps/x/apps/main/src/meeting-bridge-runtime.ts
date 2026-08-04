import path from 'node:path';

import {
  isMeetingBridgeEnabled,
  MeetingBridgeSupervisor,
  resolveMeetingBridgeBinary,
  type BridgeSpeakerEvidence,
  type MeetingBridgePaths,
  type MeetingBridgeSupervisorOptions,
} from './meeting-bridge.js';
import type { MeetingSpeakerEvidence } from './meeting-speaker-resolver.js';

/**
 * The small lifecycle seam between existing Rowboat transcription and the
 * experimental native bridge. It is intentionally additive: all operations
 * catch native bridge failures so the already-shipped renderer capture path
 * and self-hosted transcription sessions continue normally.
 */

export type BridgeLifecycleSupervisor = Pick<MeetingBridgeSupervisor, 'start' | 'stop'>;

export type MeetingBridgeRuntimeOptions = {
  paths: () => MeetingBridgePaths;
  enabled?: () => boolean;
  createSupervisor?: (options: MeetingBridgeSupervisorOptions) => BridgeLifecycleSupervisor;
  applySpeakerEvidence: (
    meetingId: string,
    evidence: readonly MeetingSpeakerEvidence[],
  ) => Promise<void> | void;
};

export type MeetingBridgeRuntime = {
  begin(meetingId: string): Promise<boolean>;
  restart(meetingId: string): Promise<boolean>;
  stop(meetingId: string): Promise<void>;
};

/** Resolve the repository root from Electron's development `app.getAppPath()`. */
export function resolveRowboatRepositoryRoot(appPath: string): string {
  if (!path.isAbsolute(appPath)) throw new Error('Rowboat app path must be absolute');
  // Development path is <repo>/apps/x/apps/main.
  return path.resolve(appPath, '../../../../');
}

export function createMeetingBridgeRuntime(options: MeetingBridgeRuntimeOptions): MeetingBridgeRuntime {
  const enabled = options.enabled ?? isMeetingBridgeEnabled;
  let activeMeetingId: string | null = null;

  const supervisor = (options.createSupervisor ?? ((supervisorOptions) => new MeetingBridgeSupervisor(supervisorOptions)))({
    enabled,
    resolveBinary: () => resolveMeetingBridgeBinary(options.paths()),
    onEvent: (event) => {
      if (event.type !== 'speaker_evidence' || activeMeetingId !== event.evidence.meetingId) return;
      // The pending-upsert delivery is deliberately best-effort. A bridge
      // failure or a temporarily unavailable transcription implementation can
      // never stop the existing audio capture/ASR route.
      // Start a new promise chain first so a synchronous resolver exception is
      // contained too. The native helper must never interrupt current ASR.
      void Promise.resolve()
        .then(() => options.applySpeakerEvidence(event.evidence.meetingId, [toMeetingSpeakerEvidence(event.evidence)]))
        .catch(() => {});
    },
  });

  async function activate(meetingId: string): Promise<boolean> {
    if (!enabled()) return false;
    if (activeMeetingId === meetingId) return true;
    const previousMeetingId = activeMeetingId;
    // Set the filter before Start is sent. A fast native helper can emit
    // evidence as soon as it processes that command, and that first identity
    // observation must not be dropped while `start()` is awaiting its write.
    activeMeetingId = meetingId;
    try {
      const started = await supervisor.start(meetingId);
      if (!started) activeMeetingId = previousMeetingId;
      return started;
    } catch {
      activeMeetingId = previousMeetingId;
      return false;
    }
  }

  return {
    begin: activate,
    // A self-hosted ASR session restart does not need to tear down healthy
    // native capture. An active matching bridge is deliberately left running;
    // its own bounded supervisor handles a crashed helper.
    restart: activate,
    async stop(meetingId: string): Promise<void> {
      if (activeMeetingId !== meetingId) return;
      activeMeetingId = null;
      try {
        await supervisor.stop();
      } catch {
        // Stop is cleanup. The normal transcript finalize/reset result wins.
      }
    },
  };
}

/** Discard bridge-only observation fields at the transcription trust boundary. */
function toMeetingSpeakerEvidence(evidence: BridgeSpeakerEvidence): MeetingSpeakerEvidence {
  return {
    source: evidence.source,
    participantId: evidence.participantId,
    displayName: evidence.displayName,
    isSelf: evidence.isSelf,
    isActive: evidence.isActive,
    isMuted: evidence.isMuted,
    startSample: evidence.startSample,
    endSample: evidence.endSample,
    confidence: evidence.confidence,
  };
}
