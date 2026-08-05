/**
 * Labels are untrusted hints, not proof of acoustic isolation. Keep this list
 * deliberately narrow: transport names ("Bluetooth") and brands ("Bose")
 * also describe loudspeakers and must fail closed.
 */
export function isKnownIsolatedOutputLabel(label: string): boolean {
    const normalized = label.trim().toLowerCase();
    if (!normalized) return false;
    return ['headphone', 'headset', 'airpod', 'earpod', 'earphone', 'earbud']
        .some(pattern => normalized.includes(pattern));
}
