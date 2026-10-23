import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { soundCloudMediaUrl, soundCloudSessionId } from './mediaSource'

// Unmodified upstream file from the actual Cargo dependency, including its
// MIT/Apache notice. Only Tauri's normal build template values are substituted.
const core = readFileSync(new URL('../../qa/fixtures/tauri-2.12.4-core.js', import.meta.url), 'utf8')
const token = 'a'.repeat(48)
function actualTauriConverter(os: 'windows' | 'macos', scheme = 'http') {
  const window = { __TAURI_INTERNALS__: {} as { convertFileSrc(path: string, protocol?: string): string } }
  runInNewContext(core.replace('__TEMPLATE_os_name__', JSON.stringify(os)).replace('__TEMPLATE_protocol_scheme__', JSON.stringify(scheme)), { window })
  return window.__TAURI_INTERNALS__.convertFileSrc
}

describe('native SoundCloud media capability paths', () => {
  it('uses the exact official Tauri core corresponding to the locked native dependency', () => {
    expect(createHash('sha256').update(core).digest('hex')).toBe('71056442a732cca1f03572ccae96d68e16104c3a591c64de9618cd304e063070')
    const lock = readFileSync(new URL('../../src-tauri/Cargo.lock', import.meta.url), 'utf8')
    expect(lock).toMatch(/\[\[package\]\]\s+name = "tauri"\s+version = "2\.12\.4"/u)
  })

  it.each([
    ['windows', 'http', `http://pulse-media.localhost/${token}/0`],
    ['windows', 'https', `https://pulse-media.localhost/${token}/0`],
    ['macos', 'http', `pulse-media://localhost/${token}/0`],
  ] as const)('keeps the media index separate using actual Tauri on %s with %s', (os, scheme, expected) => {
    const convert = actualTauriConverter(os, scheme)
    // Negative control recreates the former bug against upstream code rather
    // than duplicating its percent-encoding behavior in a mock implementation.
    const incorrectlyConverted = convert(`${token}/0`, 'pulse-media')
    expect(new URL(incorrectlyConverted).pathname).toContain('%2F0')
    expect(() => soundCloudSessionId(incorrectlyConverted)).toThrow()
    const correct = soundCloudMediaUrl(`${token}/0`, convert)
    expect(correct).toBe(expected)
    expect(new URL(correct).pathname.split('/')).toEqual(['', token, '0'])
    expect(soundCloudSessionId(correct)).toBe(token)
  })

  it.each([
    '', `${token}`, `${token}/1`, `${token}/00`, `${token}/0/`, `${token.toUpperCase()}/0`,
    `${token}%2F0`, `${token}/0?extra=1`, `${token}/../0`, `/${token}/0`, `https://pulse-media.localhost/${token}/0`,
  ])('rejects a malformed prepared path without converting it: case %#', path => {
    let calls = 0
    expect(() => soundCloudMediaUrl(path, () => { calls++; return '' })).toThrow()
    expect(calls).toBe(0)
  })

  it.each([
    '', `http://pulse-media.localhost/${token}`, `http://pulse-media.localhost/${token}/1`,
    `http://pulse-media.localhost/${token}/0?extra=1`, `http://pulse-media.localhost/${token}/0#fragment`,
    `http://pulse-media.localhost/${token}%2F0`, `http://pulse-media.localhost/${token}/00`,
    `http://pulse-media.localhost/${token}/0/`, `http://pulse-media.localhost:8765/${token}/0`,
    `http://user:pass@pulse-media.localhost/${token}/0`, `http://other.localhost/${token}/0`,
    `https://example.test/${token}/0`, `pulse-media://other/${token}/0`,
    `file://localhost/${token}/0`, `pulse-media://localhost/${token.toUpperCase()}/0`,
  ])('rejects an invalid session URL instead of releasing any session: case %#', url => {
    expect(() => soundCloudSessionId(url)).toThrow('Неверный адрес подготовленного аудиоисточника.')
  })
})
