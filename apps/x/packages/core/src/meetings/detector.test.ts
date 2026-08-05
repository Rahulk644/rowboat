import { describe, expect, it } from "vitest";
import {
    observeExternalCallEnd,
    type ExternalCallEndState,
} from "./detector.js";

const freshState = (): ExternalCallEndState => ({
    externalAppSeen: false,
    callEndFired: false,
});

describe("observeExternalCallEnd", () => {
    it("keeps recording when Zoom disappears from mic owners while its meeting surface remains active", () => {
        const zoomOnMic = observeExternalCallEnd(freshState(), {
            selfCaptureActive: true,
            externalMeetingAppOwnsMic: true,
            lifecycleEvidence: "active",
        });
        expect(zoomOnMic.shouldEnd).toBe(false);
        expect(zoomOnMic.state.externalAppSeen).toBe(true);

        // Zoom releases its microphone owner when the local participant
        // mutes. Its active meeting surface is positive proof that capture
        // must continue despite the missing mic-owner entry.
        const mutedZoom = observeExternalCallEnd(zoomOnMic.state, {
            selfCaptureActive: true,
            externalMeetingAppOwnsMic: false,
            lifecycleEvidence: "active",
        });
        expect(mutedZoom.shouldEnd).toBe(false);
        expect(mutedZoom.state).toEqual(zoomOnMic.state);

        // A failed/unavailable surface read is also not a call-end signal.
        const unavailableSurface = observeExternalCallEnd(mutedZoom.state, {
            selfCaptureActive: true,
            externalMeetingAppOwnsMic: false,
            lifecycleEvidence: "unknown",
        });
        expect(unavailableSurface.shouldEnd).toBe(false);
        expect(unavailableSurface.state).toEqual(zoomOnMic.state);
    });

    it("ends only after a trusted lifecycle source positively proves the observed call ended", () => {
        const active = observeExternalCallEnd(freshState(), {
            selfCaptureActive: true,
            externalMeetingAppOwnsMic: true,
            lifecycleEvidence: "active",
        });
        const ended = observeExternalCallEnd(active.state, {
            selfCaptureActive: true,
            externalMeetingAppOwnsMic: false,
            lifecycleEvidence: "ended",
        });
        expect(ended.shouldEnd).toBe(true);
        expect(ended.state.callEndFired).toBe(true);

        // The terminal callback cannot repeat on later snapshots.
        expect(observeExternalCallEnd(ended.state, {
            selfCaptureActive: true,
            externalMeetingAppOwnsMic: false,
            lifecycleEvidence: "ended",
        }).shouldEnd).toBe(false);
    });
});
