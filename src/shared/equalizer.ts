/** A small, deterministic equalizer model shared by settings and playback. */
export const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const

export type EqualizerPresetId = 'flat' | 'custom' | 'rap' | 'hip-hop' | 'pop' | 'rock' | 'electronic' | 'jazz' | 'classical'
export type EqualizerPreset = { id: EqualizerPresetId; name: string; description: string; bands: readonly number[] }
export type EqualizerSettings = { enabled: boolean; preset: EqualizerPresetId; bands: number[]; preamp: number }

const flat = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as const
export const EQ_PRESETS: readonly EqualizerPreset[] = [
  { id: 'flat', name: 'Ровный', description: 'Чистый исходный баланс', bands: flat },
  { id: 'rap', name: 'Рэп', description: 'Плотный низ и разборчивый голос', bands: [4, 4, 2, -1, -2, 1, 3, 3, 2, 1] },
  { id: 'hip-hop', name: 'Хип-хоп', description: 'Ударный бас и яркая атака', bands: [5, 5, 3, 0, -2, 0, 2, 3, 3, 2] },
  { id: 'pop', name: 'Поп', description: 'Вокал впереди, мягкий низ', bands: [-1, 1, 2, 2, 1, 2, 3, 2, 1, 0] },
  { id: 'rock', name: 'Рок', description: 'Гитары и живые барабаны', bands: [3, 2, 1, -1, -2, 1, 3, 4, 2, 1] },
  { id: 'electronic', name: 'Электроника', description: 'Глубокий саб и сияющие верха', bands: [5, 4, 2, 0, -1, 1, 2, 3, 4, 4] },
  { id: 'jazz', name: 'Джаз', description: 'Тёплая середина и воздух', bands: [2, 1, 0, 1, 2, 2, 1, 2, 3, 3] },
  { id: 'classical', name: 'Классика', description: 'Естественная сцена и детали', bands: [3, 2, 1, 0, 0, 0, 1, 2, 3, 4] },
] as const

export const DEFAULT_EQUALIZER: EqualizerSettings = { enabled: false, preset: 'flat', bands: [...flat], preamp: 0 }
const presetIds = new Set<EqualizerPresetId>(['custom', ...EQ_PRESETS.map(item => item.id)])
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const clampBand = (value: number) => Math.max(-12, Math.min(12, Math.round(value * 10) / 10))

export function presetById(id: EqualizerPresetId) { return EQ_PRESETS.find(item => item.id === id) || EQ_PRESETS[0] }

/** Sanitizes persisted data so a malformed profile can never produce runaway gain. */
export function normalizeEqualizer(value: unknown): EqualizerSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_EQUALIZER, bands: [...flat] }
  const source = value as Partial<EqualizerSettings>
  const bands = Array.isArray(source.bands) && source.bands.length === EQ_FREQUENCIES.length && source.bands.every(finite)
    ? source.bands.map(clampBand)
    : [...flat]
  const requested = typeof source.preset === 'string' && presetIds.has(source.preset as EqualizerPresetId) ? source.preset as EqualizerPresetId : 'custom'
  const preset = requested === 'custom' ? 'custom' : bands.every((band, index) => band === presetById(requested).bands[index]) ? requested : 'custom'
  return { enabled: source.enabled === true, preset, bands, preamp: finite(source.preamp) ? Math.max(-12, Math.min(0, Math.round(source.preamp * 10) / 10)) : 0 }
}
