import path from 'node:path';

import {
  isMeetingAecEnabled,
  isMeetingBridgeEnabled,
  MeetingBridgeSupervisor,
  resolveMeetingBridgeBinary,
  type BridgeAecInputFrame,
  type BridgeAecResult,
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

export type BridgeLifecycleSupervisor = Pick<
  MeetingBridgeSupervisor,
  'warm' | 'startIfReady' | 'stop' | 'processAecFrame' | 'flushAec' | 'updateAecOutputRoute'
>;

export type MeetingBridgeRuntimeOptions = {
  paths: () => MeetingBridgePaths;
  enabled?: () => boolean;
  createSupervisor?: (options: MeetingBridgeSupervisorOptions) => BridgeLifecycleSupervisor;
  applySpeakerEvidence: (
    meetingId: string,
    evidence: readonly MeetingSpeakerEvidence[],
  ) => Promise<void> | void;
  onMeetingLifecycle?: (meetingId: string, state: 'active' | 'ended') => Promise<void> | void;
};

export type MeetingBridgeRuntime = {
  warm(meetingId: string): Promise<boolean>;
  captureReady(meetingId: string, outputRouteIsolated?: boolean): Promise<boolean>;
  restart(meetingId: string): Promise<boolean>;
  /** Private Electron-main AEC request; `null` preserves raw mic capture. */
  processAecFrame(meetingId: string, mic: BridgeAecInputFrame, render: BridgeAecInputFrame): Promise<BridgeAecResult | null>;
  /** Private Electron-main final tail flush; `null` preserves raw mic capture. */
  flushAec(meetingId: string): Promise<BridgeAecResult | null>;
  /**
   * Change only AEC output-route policy for an active helper. Any returned
   * tail is consumed by `MeetingAecRouter`, not a renderer-facing API.
   */
  updateAecOutputRoute(meetingId: string, outputRouteIsolated: boolean): Promise<BridgeAecResult | null>;
  stop(meetingId: string): Promise<void>;
  /** Stop a warm or active child during Electron shutdown. */
  dispose(): Promise<void>;
};

/** Resolve the repository root from Electron's development `app.getAppPath()`. */
export function resolveRowboatRepositoryRoot(appPath: string): string {
  if (!path.isAbsolute(appPath)) throw new Error('Rowboat app path must be absolute');
  // Development path is <repo>/apps/x/apps/main.
  return path.resolve(appPath, '../../../../');
}

export function createMeetingBridgeRuntime(options: MeetingBridgeRuntimeOptions): MeetingBridgeRuntime {
  const enabled = options.enabled ?? isMeetingBridgeEnabled;
  const diagnostics = process.env.ROWBOAT_MEETING_BRIDGE_AX_DIAGNOSTICS === '1';
  let activeMeetingId: string | null = null;
  let warmedMeetingId: string | null = null;
  let warmingMeetingId: string | null = null;
  let warmPromise: Promise<boolean> | null = null;
  let warmGeneration = 0;
  // A restarted helper has a new monotonic sample origin. Keep it healthy for
  // the next meeting, but never attach its post-restart observations to the
  // current transcript without an explicit clock rebase.
  let evidenceSuspendedForActiveMeeting = false;
  let outputRouteIsolated = false;

  const supervisor = (options.createSupervisor ?? ((supervisorOptions) => new MeetingBridgeSupervisor(supervisorOptions)))({
    enabled,
    resolveBinary: () => resolveMeetingBridgeBinary(options.paths()),
    // Recover the isolated helper after a source dropout. The observation
    // boundary below quarantines the new sample clock for this meeting.
    restartBackoff: { initialMs: 250, maximumMs: 5_000, maximumRestarts: 3 },
    // Permissions often resolve quickly. Bound an unavailable helper so it
    // cannot delay the capture-ready boundary by the default five seconds.
    handshakeTimeoutMs: 1_000,
    onEvent: (event) => {
      if (event.type === 'meeting_lifecycle') {
        const activeMatch = activeMeetingId === event.meeting_id;
        if (diagnostics) {
          console.error(`[MeetingBridge] meeting lifecycle state=${event.state} activeMatch=${activeMatch}`);
        }
        if (!activeMatch) return;
        void Promise.resolve()
          .then(() => options.onMeetingLifecycle?.(event.meeting_id, event.state))
          .catch(() => {});
        return;
      }
      if (event.type !== 'speaker_evidence') {
        if (diagnostics) {
          const detail = event.type === 'error' ? ` code=${event.code}` : '';
          console.error(`[MeetingBridge] event type=${event.type}${detail}`);
        }
        return;
      }
      const activeMatch = activeMeetingId === event.evidence.meetingId;
      if (diagnostics) {
        console.error(
          `[MeetingBridge] speaker evidence activeMatch=${activeMatch} startSample=${event.evidence.startSample} endSample=${event.evidence.endSample}`,
        );
      }
      if (!activeMatch) return;
      if (evidenceSuspendedForActiveMeeting) {
        if (diagnostics) console.error('[MeetingBridge] speaker evidence ignored after helper recovery');
        return;
      }
      // The pending-upsert delivery is deliberately best-effort. A bridge
      // failure or a temporarily unavailable transcription implementation can
      // never stop the existing audio capture/ASR route.
      // Start a new promise chain first so a synchronous resolver exception is
      // contained too. The native helper must never interrupt current ASR.
      void Promise.resolve()
        .then(() => options.applySpeakerEvidence(event.evidence.meetingId, [toMeetingSpeakerEvidence(event.evidence)]))
        .then(() => {
          if (diagnostics) console.error('[MeetingBridge] speaker evidence applied');
        })
        .catch(() => {
          if (diagnostics) console.error('[MeetingBridge] speaker evidence apply failed');
        });
    },
    onStatus: (status) => {
      if (status.state === 'recovering' && activeMeetingId && status.restartCount > 0) {
        evidenceSuspendedForActiveMeeting = true;
      }
      if (diagnostics) {
        console.error(`[MeetingBridge] status=${status.state} restarts=${status.restartCount}`);
      }
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
      const started = await supervisor.startIfReady(meetingId, outputRouteIsolated);
      if (!started) activeMeetingId = previousMeetingId;
      return started;
    } catch {
      activeMeetingId = previousMeetingId;
      return false;
    }
  }

  return {
    async warm(meetingId: string): Promise<boolean> {
      if (!enabled()) {
        if (diagnostics) console.error('[MeetingBridge] warm skipped reason=disabled');
        return false;
      }
      if (activeMeetingId && activeMeetingId !== meetingId) {
        if (diagnostics) console.error('[MeetingBridge] warm skipped reason=other-active-meeting');
        return false;
      }
      if (warmingMeetingId === meetingId && warmPromise) {
        if (diagnostics) console.error('[MeetingBridge] warm joined existing attempt');
        return warmPromise;
      }
      if (diagnostics) console.error('[MeetingBridge] warm requested');

      // Record identity/generation before the await. `stop()` can then
      // invalidate the attempt while a slow handshake is still resolving.
      const generation = ++warmGeneration;
      warmingMeetingId = meetingId;
      let requestedWarm: Promise<boolean>;
      try {
        // Invoke synchronously before returning. Deferring this call through a
        // microtask would allow reset/stop to run first, then spawn a helper
        // after cleanup has already completed.
        requestedWarm = supervisor.warm();
      } catch {
        warmingMeetingId = null;
        warmedMeetingId = null;
        return false;
      }
      const attempt = requestedWarm
        .then((ready) => {
          if (generation !== warmGeneration || warmingMeetingId !== meetingId) return false;
          warmedMeetingId = ready ? meetingId : null;
          if (diagnostics) console.error(`[MeetingBridge] warm completed ready=${ready}`);
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
    async captureReady(meetingId: string, captureOutputRouteIsolated = false): Promise<boolean> {
      outputRouteIsolated = captureOutputRouteIsolated;
      if (diagnostics) console.error('[MeetingBridge] capture ready requested');
      const started = await activate(meetingId);
      if (diagnostics) console.error(`[MeetingBridge] capture ready completed started=${started}`);
      return started;
    },
    // A self-hosted ASR session restart does not need to tear down healthy
    // native capture. An active matching bridge is left running; a crashed
    // helper stays off until the next meeting because its sample clock resets.
    async restart(meetingId: string): Promise<boolean> {
      return activeMeetingId === meetingId;
    },
    async processAecFrame(meetingId, mic, render): Promise<BridgeAecResult | null> {
      // The feature switch is intentionally separate from the native helper:
      // speaker evidence can run without making PCM available to the child.
      if (!isMeetingAecEnabled() || activeMeetingId !== meetingId) return null;
      try {
        return await supervisor.processAecFrame(meetingId, mic, render);
      } catch {
        return null;
      }
    },
    async flushAec(meetingId): Promise<BridgeAecResult | null> {
      if (!isMeetingAecEnabled() || activeMeetingId !== meetingId) return null;
      try {
        return await supervisor.flushAec(meetingId);
      } catch {
        return null;
      }
    },
    async updateAecOutputRoute(meetingId, nextOutputRouteIsolated): Promise<BridgeAecResult | null> {
      if (!isMeetingAecEnabled() || activeMeetingId !== meetingId) return null;
      outputRouteIsolated = nextOutputRouteIsolated;
      try {
        return await supervisor.updateAecOutputRoute(meetingId, nextOutputRouteIsolated);
      } catch {
        // A route-command failure must leave existing ASR on the raw path; it
        // must not restart the helper or invalidate its speaker-evidence clock.
        return null;
      }
    },
    async stop(meetingId: string): Promise<void> {
      if (activeMeetingId && activeMeetingId !== meetingId) return;
      if (!activeMeetingId && warmedMeetingId !== meetingId && warmingMeetingId !== meetingId) return;
      ++warmGeneration;
      activeMeetingId = null;
      warmedMeetingId = null;
      evidenceSuspendedForActiveMeeting = false;
      outputRouteIsolated = false;
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
    async dispose(): Promise<void> {
      ++warmGeneration;
      activeMeetingId = null;
      warmedMeetingId = null;
      warmingMeetingId = null;
      warmPromise = null;
      evidenceSuspendedForActiveMeeting = false;
      outputRouteIsolated = false;
      try {
        await supervisor.stop();
      } catch {
        // The helper is optional. A shutdown must not wait on an already-dead
        // native child or a stalled pipe.
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
