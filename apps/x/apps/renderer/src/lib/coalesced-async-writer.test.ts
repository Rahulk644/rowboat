import { afterEach, describe, expect, it, vi } from 'vitest'
import { CoalescedAsyncWriter } from './coalesced-async-writer'

afterEach(() => {
  vi.useRealTimers()
})

describe('CoalescedAsyncWriter', () => {
  it('writes during a continuously active stream instead of starving', async () => {
    vi.useFakeTimers()
    const write = vi.fn(async () => {})
    const writer = new CoalescedAsyncWriter(write, 1_000)

    writer.schedule()
    await vi.advanceTimersByTimeAsync(400)
    writer.schedule()
    await vi.advanceTimersByTimeAsync(400)
    writer.schedule()
    await vi.advanceTimersByTimeAsync(200)

    expect(write).toHaveBeenCalledTimes(1)
  })

  it('serializes a dirty follow-up write after an in-flight write', async () => {
    vi.useFakeTimers()
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => { releaseFirst = resolve })
    const write = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined)
    const writer = new CoalescedAsyncWriter(write, 100)

    writer.schedule()
    await vi.advanceTimersByTimeAsync(100)
    writer.schedule()
    expect(write).toHaveBeenCalledTimes(1)

    releaseFirst()
    await first
    await vi.advanceTimersByTimeAsync(100)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('cancels a trailing write and settles the active write before final output', async () => {
    vi.useFakeTimers()
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => { releaseFirst = resolve })
    const write = vi.fn().mockImplementation(() => first)
    const writer = new CoalescedAsyncWriter(write, 100)

    writer.schedule()
    await vi.advanceTimersByTimeAsync(100)
    writer.schedule()
    let settled = false
    const settling = writer.cancelAndSettle().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseFirst()
    await settling
    await vi.advanceTimersByTimeAsync(100)
    expect(write).toHaveBeenCalledTimes(1)
  })
})
