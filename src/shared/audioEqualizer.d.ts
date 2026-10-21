import type { EqualizerSettings } from './equalizer'
export type EqualizerGraph = {
  apply(value: EqualizerSettings): void
  prepare(): Promise<void>
  resume(): Promise<void>
  destroy(): void
  readonly active: boolean
  readonly connected: boolean
}
declare global {
  var __PULSE_CREATE_EQUALIZER__: (media: HTMLMediaElement, options?: { AudioContext?: typeof AudioContext }) => EqualizerGraph
}
