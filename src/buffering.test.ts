import { describe, expect, it } from 'vitest'
import { normalizeBufferedRanges, secondsBufferedAhead } from './buffering'

describe('actual buffered islands', () => {
  it('preserves unloaded gaps rather than drawing through the furthest end', () => {
    const ranges = normalizeBufferedRanges([[60, 80], [0, 20], [18, 25]], 100)
    expect(ranges).toEqual([[0, 25], [60, 80]])
    expect(secondsBufferedAhead(ranges, 30)).toBe(0)
    expect(secondsBufferedAhead(ranges, 10)).toBe(15)
    expect(secondsBufferedAhead(ranges, 64)).toBe(16)
  })
  it('bounds malformed source data and clears unknown-duration ranges', () => {
    expect(normalizeBufferedRanges([[-8, 20], [90, 120], [12, 4], [NaN, 50], [2, Infinity], ['1', 2]], 100)).toEqual([[0, 20], [90, 100]])
    expect(normalizeBufferedRanges([[0, 20]], 0)).toEqual([])
    expect(normalizeBufferedRanges([[0, 20]], Infinity)).toEqual([])
    expect(secondsBufferedAhead([[0, 20]], NaN)).toBe(0)
  })
})
