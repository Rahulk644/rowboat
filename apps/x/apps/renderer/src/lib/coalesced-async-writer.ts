/**
 * Coalesce a hot stream of change notifications into bounded, serialized
 * writes. Unlike a trailing-edge debounce, a continuously active stream can
 * never postpone the first write forever.
 */
export class CoalescedAsyncWriter {
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  private active: Promise<void> | null = null
  private cancelled = false
  private readonly write: () => Promise<void>
  private readonly delayMs: number

  constructor(write: () => Promise<void>, delayMs: number) {
    this.write = write
    this.delayMs = delayMs
  }

  schedule(): void {
    if (this.cancelled) return
    this.dirty = true
    if (this.timer || this.active) return
    this.arm()
  }

  cancel(): void {
    this.cancelled = true
    this.dirty = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private arm(): void {
    this.timer = setTimeout(() => {
      this.timer = null
      void this.start().catch(() => {
        // The owner reports write failures. Keep scheduled callbacks from
        // creating an unhandled rejection if that policy changes later.
      })
    }, this.delayMs)
  }

  private start(): Promise<void> {
    if (this.active) return this.active
    if (!this.dirty || this.cancelled) return Promise.resolve()

    this.dirty = false
    const run = this.write()
    this.active = run
    void run.finally(() => {
      if (this.active === run) this.active = null
      if (this.dirty && !this.cancelled && !this.timer) this.arm()
    }).catch(() => {})
    return run
  }
}
