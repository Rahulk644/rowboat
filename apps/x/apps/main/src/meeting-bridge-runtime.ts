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

export type BridgeLifecycleSupervisor = Pick<MeetingBridgeSupervisor, 'warm' | 'startIfReady' | 'stop'>;

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
  warm(meetingId: string): Promise<boolean>;
  captureReady(meetingId: string): Promise<boolean>;
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
  let warmedMeetingId: string | null = null;
  let warmingMeetingId: string | null = null;
  let warmPromise: Promise<boolean> | null = null;
  let warmGeneration = 0;

  const supervisor = (options.createSupervisor ?? ((supervisorOptions) => new MeetingBridgeSupervisor(supervisorOptions)))({
    enabled,
    resolveBinary: () => resolveMeetingBridgeBinary(options.paths()),
    // The current helper's monotonic sample origin resets after a process
    // restart. Until an offset can cross that boundary, evidence must stay off
    // for the rest of this meeting instead of attaching wrong speaker names.
    restartBackoff: { initialMs: 250, maximumMs: 5_000, maximumRestarts: 0 },
    // Permissions often resolve quickly. Bound an unavailable helper so it
    // cannot delay the capture-ready boundary by the default five seconds.
    handshakeTimeoutMs: 1_000,
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
    const pendingWarm = warmingMeetingId === meetingId ? warmPromise : null;
    if (pendingWarm) await pendingWarm;
    // A cold process changes the native sample origin. Starting it after the
    // renderer graph is connected would make AX evidence worse than no names.
    if (!enabled() || warmedMeetingId !== meetingId) return false;
    if (activeMeetingId === meetingId) return true;
    const previousMeetingId = activeMeetingId;
    // Set the filter before Start is sent. A fast native helper can emit
    // evidence as soon as it processes that command, and that first identity
    // observation must not be dropped while `start()` is awaiting its write.
    activeMeetingId = meetingId;
    try {
      const started = await supervisor.startIfReady(meetingId);
      if (!started) activeMeetingId = previousMeetingId;
      return started;
    } catch {
      activeMeetingId = previousMeetingId;
      return false;
    }
  }

  return {
    async warm(meetingId: string): Promise<boolean> {
      if (!enabled()) return false;
      if (activeMeetingId && activeMeetingId !== meetingId) return false;
      if (warmingMeetingId === meetingId && warmPromise) return warmPromise;

      // Record identity/generation before the await. `stop()` can then
      // invalidate the attempt while a slow handshake is still resolving.
      const generation = ++warmGeneration;
      warmingMeetingId = meetingId;
      const attempt = Promise.resolve()
        .then(() => supervisor.warm())
        .then((ready) => {
          if (generation !== warmGeneration || warmingMeetingId !== meetingId) return false;
          warmedMeetingId = ready ? meetingId : null;
          return ready;
        })
        .catch(() => {
          if (generation === warmGeneration && warmingMeetingId === meetingId) {
            warmedMeetingId = null;
          }
          return false;
        })
        .finally(() => {
          if (generation === warmGeneration && warmingMeetingId === meetingId) {
            warmingMeetingId = null;
            warmPromise = null;
          }
        });
      warmPromise = attempt;
      return attempt;
    },
    captureReady: activate,
    // A self-hosted ASR session restart does not need to tear down healthy
    // native capture. An active matching bridge is left running; a crashed
    // helper stays off until the next meeting because its sample clock resets.
    async restart(meetingId: string): Promise<boolean> {
      return activeMeetingId === meetingId;
    },
    async stop(meetingId: string): Promise<void> {
      if (activeMeetingId && activeMeetingId !== meetingId) return;
      if (!activeMeetingId && warmedMeetingId !== meetingId && warmingMeetingId !== meetingId) return;
      ++warmGeneration;
      activeMeetingId = null;
      warmedMeetingId = null;
      if (warmingMeetingId === meetingId) {
        warmingMeetingId = null;
        warmPromise = null;
      }
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
