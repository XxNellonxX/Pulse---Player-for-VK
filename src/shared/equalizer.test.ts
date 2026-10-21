import { describe, expect, it } from 'vitest'
import { DEFAULT_EQUALIZER, EQ_FREQUENCIES, EQ_PRESETS, normalizeEqualizer } from './equalizer'

describe('persisted equalizer profiles', () => {
  it('keeps disabled default neutral and returns independent arrays', () => {
    const first = normalizeEqualizer(undefined), second = normalizeEqualizer(undefined)
    first.bands[0] = 10
    expect(second).toEqual(DEFAULT_EQUALIZER)
    expect(second.enabled).toBe(false)
  })
  it('bounds finite levels and rejects malformed curves without runaway gain', () => {
    expect(normalizeEqualizer({ enabled: true, preset: 'rap', bands: [Infinity, 0], preamp: 100 })).toEqual({ enabled: true, preset: 'custom', bands: Array(10).fill(0), preamp: 0 })
    expect(normalizeEqualizer({ preset: 'custom', bands: [-99, 99, 0, 0, 0, 0, 0, 0, 0, 0], preamp: -99 })).toMatchObject({ preset: 'custom', bands: [-12, 12, 0, 0, 0, 0, 0, 0, 0, 0], preamp: -12 })
  })
  it('keeps manual edits custom and accepts only matching preset names', () => {
    const rap = EQ_PRESETS.find(item => item.id === 'rap')!
    expect(normalizeEqualizer({ preset: 'rap', bands: [...rap.bands] }).preset).toBe('rap')
    expect(normalizeEqualizer({ preset: 'rap', bands: Array(10).fill(0) }).preset).toBe('custom')
    expect(normalizeEqualizer({ preset: 'custom', bands: [...rap.bands] }).preset).toBe('custom')
  })
  it('offers seven distinct bounded genre curves in addition to neutral', () => {
    expect(EQ_PRESETS.filter(item => item.id !== 'flat')).toHaveLength(7)
    expect(new Set(EQ_PRESETS.map(item => item.bands.join(','))).size).toBe(8)
    expect(EQ_PRESETS.every(item => item.bands.length === EQ_FREQUENCIES.length && item.bands.every(value => value >= -12 && value <= 12))).toBe(true)
  })
})
