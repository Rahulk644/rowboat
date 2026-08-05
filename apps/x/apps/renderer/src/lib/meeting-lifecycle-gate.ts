export type MeetingLifecycleOperation = 'starting' | 'stopping';

/** Synchronous guard for async React event handlers and external triggers. */
export class MeetingLifecycleGate {
    private operation: MeetingLifecycleOperation | null = null;
    private generation = 0;

    begin(operation: MeetingLifecycleOperation): number | null {
        if (this.operation) return null;
        this.operation = operation;
        this.generation += 1;
        return this.generation;
    }

    isCurrent(token: number): boolean {
        return this.operation !== null && token === this.generation;
    }

    finish(token: number): void {
        if (token === this.generation) this.operation = null;
    }

    invalidate(): void {
        this.generation += 1;
        this.operation = null;
    }
}
