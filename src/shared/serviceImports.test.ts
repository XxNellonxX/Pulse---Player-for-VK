import { describe, expect, it } from 'vitest'
import { parseImportCsv, parseServiceExport } from './serviceImports'

describe('collection metadata export parser', () => {
  it('retains CSV source order, deliberate repeats, artist punctuation, ISRC and duration units', () => {
    const source = parseServiceExport('\uFEFFTrack URI,Track Name,Artist Name(s),Album Name,Duration (ms),ISRC,Explicit\r\nspotify:track:a,"Song, Pt. 2","Tyler, The Creator;Guest",LP,183400,US-ABC-26-12345,TRUE\r\nspotify:track:b,Other,Artist,EP,150000,,false\r\nspotify:track:a,"Song, Pt. 2","Tyler, The Creator;Guest",LP,183400,US-ABC-26-12345,TRUE', 'spotify', 'My likes.csv')
    expect(source.complete).toBe(true)
    expect(source.entries.map(item => item.position)).toEqual([0, 1, 2])
    expect(source.entries.map(item => item.sourceId)).toEqual(['spotify:track:a', 'spotify:track:b', 'spotify:track:a'])
    expect(source.entries[0].artists).toEqual(['Tyler, The Creator', 'Guest'])
    expect(source.entries[0].duration).toBe(183.4)
    expect(source.entries[0].isrc).toBe('USABC2612345')
    expect(source.entries[0].explicit).toBe(true)
    expect(source.entries[1].explicit).toBe(false)
  })
  it('accepts semicolon and tab exports with quoted delimiters, multiline titles and escaped quotes', () => {
    expect(parseImportCsv('title;artist\r\n"He said ""Hi""; again\nTonight";Artist')).toEqual([['title', 'artist'], ['He said "Hi"; again\nTonight', 'Artist']])
    const source = parseServiceExport('title\tartist\tduration\nSong\tArtist\t185.5', 'yandex', 'Collection.tsv')
    expect(source.entries[0].duration).toBe(185.5)
    expect(source.entries[0].title).toBe('Song')
  })
  it('retains missing positions and reports incomplete metadata without silently reordering', () => {
    const source = parseServiceExport('title,artist\nSong,Artist\nHidden,\nSecond,Artist', 'yandex', 'likes.csv')
    expect(source.complete).toBe(false)
    expect(source.total).toBe(3)
    expect(source.entries.map(entry => entry.position)).toEqual([0, 2])
    expect(source.warnings[0]).toContain('Строка 2')
  })
  it('accepts explicit structured metadata without preview audio or credentials', () => {
    const source = parseServiceExport(JSON.stringify({ title: 'Export', tracks: [{ id: 'a', title: 'Song', artists: [{ name: 'Artist' }], durationMs: 123400, explicit: false, url: 'secret-audio', access_token: 'secret' }, { id: 'a', title: 'Song', artists: ['Artist'], duration: 123.4 }] }), 'spotify', 'export.json')
    expect(source.title).toBe('Export')
    expect(source.entries).toHaveLength(2)
    expect(source.entries[0].duration).toBe(123.4)
    expect(source.entries[0]).not.toHaveProperty('url')
    expect(source.entries[0]).not.toHaveProperty('access_token')
  })
  it('rejects ambiguous malformed exports and oversized metadata', () => {
    for (const csv of ['title,artist\n"Unclosed,Artist', 'name,album\nSong,LP', 'title,artist\nSong,', 'title,artist\n"Song"garbage,Artist']) expect(() => parseServiceExport(csv, 'yandex', 'x.csv')).toThrow()
    expect(() => parseServiceExport('{"tokens":[]}', 'spotify', 'x.json')).toThrow()
    expect(() => parseServiceExport('x'.repeat(8 * 1024 * 1024 + 1), 'spotify', 'x.csv')).toThrow()
  })
})
