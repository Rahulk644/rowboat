import { describe, expect, it } from 'vitest';
import { isKnownIsolatedOutputLabel } from './meeting-output-route';

describe('meeting output-route evidence', () => {
    it.each([
        'Bose Bluetooth Speaker',
        'Bluetooth Audio',
        'Jabra Speak 750',
        'MacBook Air Speakers',
        'Sony Wireless Speaker',
        '',
    ])('fails closed for ambiguous output label %s', (label) => {
        expect(isKnownIsolatedOutputLabel(label)).toBe(false);
    });

    it.each([
        'Rahul’s AirPods Pro',
        'USB Headset',
        'External Headphones',
        'Wired Earbuds',
    ])('accepts an explicit isolated-device label %s', (label) => {
        expect(isKnownIsolatedOutputLabel(label)).toBe(true);
    });
});
