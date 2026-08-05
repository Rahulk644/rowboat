import { describe, expect, it } from 'vitest';
import { MeetingLifecycleGate } from './meeting-lifecycle-gate';

describe('MeetingLifecycleGate', () => {
    it('rejects duplicate and competing async meeting operations', () => {
        const gate = new MeetingLifecycleGate();
        const start = gate.begin('starting');
        expect(start).not.toBeNull();
        expect(gate.begin('starting')).toBeNull();
        expect(gate.begin('stopping')).toBeNull();
        gate.finish(start!);
        expect(gate.begin('stopping')).not.toBeNull();
    });

    it('invalidates late async completion tokens', () => {
        const gate = new MeetingLifecycleGate();
        const start = gate.begin('starting')!;
        gate.invalidate();
        expect(gate.isCurrent(start)).toBe(false);
        gate.finish(start);
        expect(gate.begin('starting')).not.toBeNull();
    });
});
