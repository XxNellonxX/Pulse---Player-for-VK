import { describe, expect, it } from 'vitest'
import { normalizeRecordingText, rankSoundCloudCandidates, recordingCensorship, vkSourceHint } from './sourceMatching'
import type { RecordingMetadata, SoundCloudCandidate } from './sourceMatching'

const track = { id: 'vk-1-2', title: 'Капля испуга', artist: 'Исполнитель', duration: 180 };
const candidate = (changes: Partial<SoundCloudCandidate> = {}): SoundCloudCandidate => ({
  id: 'sc:123', title: track.title, artist: track.artist, duration: track.duration, streamable: true, ...changes,
});

describe('source discovery is a proposal, never an implicit recording substitution', () => {
  it('offers a single metadata match without automatically selecting it', () => {
    const result = rankSoundCloudCandidates(track, [candidate()]);
    expect(result).toMatchObject({ status: 'unique', suggestedId: 'sc:123' });
    expect(result.selectedId).toBeUndefined();
    expect(result.candidates[0]).toMatchObject({ quality: 'exact', confirmed: false, censorship: 'unknown' });
  });

  it('keeps duplicate uploads ambiguous even if one has a slightly closer duration', () => {
    const result = rankSoundCloudCandidates(track, [candidate({ id: 'sc:2', duration: 181 }), candidate()]);
    expect(result.status).toBe('ambiguous');
    expect(result.selectedId).toBeUndefined();
    expect(result.suggestedId).toBeUndefined();
  });

  it('does not manufacture ambiguity from repeated search-page IDs', () => {
    expect(rankSoundCloudCandidates(track, [candidate(), candidate()]).status).toBe('unique');
  });

  it('restores a source only from explicit confirmation belonging to this track', () => {
    const result = rankSoundCloudCandidates(track, [candidate(), candidate({ id: 'sc:2' })], { confirmed: { trackId: track.id, sourceId: 'sc:2' } });
    expect(result).toMatchObject({ status: 'confirmed', selectedId: 'sc:2' });
    expect(result.candidates[0].candidate.id).toBe('sc:2');
    expect(rankSoundCloudCandidates(track, [candidate()], { confirmed: { trackId: 'vk-9-9', sourceId: 'sc:123' } }).selectedId).toBeUndefined();
  });

  it('does not silently replace a removed or unavailable saved source', () => {
    expect(rankSoundCloudCandidates(track, [candidate()], { confirmed: { trackId: track.id, sourceId: 'missing' } }).selectedId).toBeUndefined();
    const result = rankSoundCloudCandidates(track, [candidate({ streamable: false })], { confirmed: { trackId: track.id, sourceId: 'sc:123' } });
    expect(result.status).toBe('none');
    expect(result.selectedId).toBeUndefined();
    expect(result.candidates[0].reasons).toContain('unavailable');
  });

  it('preserves candidate fields and does not mutate search results', () => {
    const input = Object.freeze([Object.freeze(candidate({ permalinkUrl: 'https://soundcloud.com/artist/track' }))]);
    const result = rankSoundCloudCandidates(track, input);
    expect(result.candidates[0].candidate).toBe(input[0]);
    expect(result.candidates[0].candidate.permalinkUrl).toBe('https://soundcloud.com/artist/track');
  });
});

describe('recording identity guards', () => {
  it('normalizes Unicode, case and punctuation without transliteration', () => {
    expect(normalizeRecordingText(' ＴＥＳＴ — Ёж ')).toBe('test еж');
    expect(rankSoundCloudCandidates(track, [candidate({ title: 'КАПЛЯ—ИСПУГА', artist: 'исполнитель' })]).candidates[0].quality).toBe('exact');
    expect(rankSoundCloudCandidates(track, [candidate({ artist: 'Ispolnitel' })]).status).toBe('none');
  });

  it('rejects a different artist rather than relying on a partial name', () => {
    const result = rankSoundCloudCandidates(track, [candidate({ artist: 'Исполнитель фанат' })]);
    expect(result.status).toBe('none');
    expect(result.candidates[0].reasons).toContain('artist');
  });

  it('allows imperfect title matches for review but does not call them exact', () => {
    const result = rankSoundCloudCandidates({ ...track, title: 'The Long Road Home' }, [candidate({ title: 'The Long Road' })]);
    expect(result.candidates[0].quality).toBe('review');
    expect(result.selectedId).toBeUndefined();
    expect(rankSoundCloudCandidates(track, [candidate({ title: 'Другая песня' })]).status).toBe('none');
  });

  it.each(['Live', 'Remix', 'Cover', 'Sped Up', 'Slowed + Reverb', 'Instrumental', 'Radio Edit', 'Remastered 2026', 'Original Mix', 'Acoustic', 'Demo'])(
    'does not confuse %s with the unqualified recording', version => {
      const result = rankSoundCloudCandidates(track, [candidate({ title: `${track.title} (${version})` })]);
      expect(result.status).toBe('none');
      expect(result.candidates[0].reasons).toContain('version');
    },
  );

  it('uses the original subtitle/version and retains the remixer identity', () => {
    const wanted = { ...track, version: 'DJ One Remix' };
    const result = rankSoundCloudCandidates(wanted, [candidate({ title: `${track.title} (DJ One Remix)` }), candidate({ id: 'sc:2', title: `${track.title} (DJ Two Remix)` })]);
    expect(result.candidates.find(item => item.candidate.id === 'sc:123')?.quality).toBe('exact');
    expect(result.candidates.find(item => item.candidate.id === 'sc:2')?.quality).toBe('mismatch');
  });

  it('retains unfamiliar version subtitles rather than discarding them', () => {
    expect(rankSoundCloudCandidates({ ...track, version: 'Alternate Take 7' }, [candidate()]).status).toBe('none');
  });

  it('ignores presentation labels while keeping actual named versions', () => {
    expect(rankSoundCloudCandidates(track, [candidate({ title: `${track.title} [Official Audio]` })]).candidates[0].quality).toBe('exact');
    expect(rankSoundCloudCandidates(track, [candidate({ title: `${track.title} (Official Remix)` })]).status).toBe('none');
  });

  it('matches featured artists whether supplied in the title or artist field', () => {
    const wanted = { ...track, title: 'Song (feat. Guest)', artist: 'Main' };
    expect(rankSoundCloudCandidates(wanted, [candidate({ title: 'Song', artist: 'Main feat. Guest' })]).candidates[0].quality).toBe('exact');
    const missingGuest = rankSoundCloudCandidates(wanted, [candidate({ title: 'Song', artist: 'Main' })]);
    expect(missingGuest.candidates[0].quality).toBe('review');
  });

  it('distinguishes missing, slightly different and incompatible durations', () => {
    expect(rankSoundCloudCandidates(track, [candidate({ duration: 182 })]).candidates[0].quality).toBe('exact');
    expect(rankSoundCloudCandidates(track, [candidate({ duration: 186 })]).candidates[0].quality).toBe('review');
    expect(rankSoundCloudCandidates(track, [candidate({ duration: 220 })]).status).toBe('none');
    for (const duration of [0, -1, NaN, Infinity]) {
      const result = rankSoundCloudCandidates(track, [candidate({ duration })]);
      expect(result.candidates[0].quality).toBe('review');
      expect(result.candidates[0].reasons).toContain('duration-unknown');
      expect(Number.isFinite(result.candidates[0].score)).toBe(true);
    }
  });

  it('does not use ISRC to overrule a different version or incompatible duration', () => {
    const wanted = { ...track, isrc: 'US-ABC-26-12345' };
    expect(rankSoundCloudCandidates(wanted, [candidate({ isrc: 'USABC2612345' })]).candidates[0].quality).toBe('exact');
    expect(rankSoundCloudCandidates(wanted, [candidate({ isrc: 'USABC2612346' })]).status).toBe('none');
    expect(rankSoundCloudCandidates(wanted, [candidate({ isrc: 'USABC2612345', version: 'Live' })]).status).toBe('none');
  });

  it('rejects empty identities and unusable provider IDs', () => {
    for (const changes of [{ title: '' }, { artist: '' }, { id: '' }, { id: 'sc:\nsecret' }]) {
      const result = rankSoundCloudCandidates(track, [candidate(changes)]);
      expect(result.status).toBe('none');
      expect(result.selectedId).toBeUndefined();
    }
  });
});

describe('explicit edition preference', () => {
  it('ranks a verified explicit edition first without resolving ambiguous uploads', () => {
    const result = rankSoundCloudCandidates(track, [candidate({ id: 'clean', title: `${track.title} (Clean)` }), candidate({ id: 'unknown' }), candidate({ id: 'explicit', title: `${track.title} (Explicit)` })], { preferExplicit: true });
    expect(result.candidates[0].candidate.id).toBe('explicit');
    expect(result.status).toBe('ambiguous');
    expect(result.selectedId).toBeUndefined();
    expect(result.candidates.find(item => item.candidate.id === 'unknown')?.censorship).toBe('unknown');
  });

  it('requires review when the desired edition is explicit but the candidate edition is unknown', () => {
    const result = rankSoundCloudCandidates({ ...track, explicit: true }, [candidate()]);
    expect(result.candidates[0]).toMatchObject({ quality: 'review', censorship: 'unknown' });
    expect(result.candidates[0].reasons).toContain('censorship-unknown');
  });

  it('does not substitute an explicit master for a requested clean edition', () => {
    const result = rankSoundCloudCandidates({ ...track, title: `${track.title} (Clean)` }, [candidate({ explicit: true })], { preferExplicit: true });
    expect(result.status).toBe('none');
    expect(result.candidates[0].reasons).toContain('censorship');
  });

  it('does not trust contradictory content flags or invent a rating from a missing field', () => {
    expect(recordingCensorship(track)).toBe('unknown');
    expect(recordingCensorship({ ...track, explicit: false })).toBe('unknown');
    expect(recordingCensorship({ ...track, title: `${track.title} (Uncensored)` })).toBe('explicit');
    const conflicting: RecordingMetadata = { ...track, title: `${track.title} (Clean)`, explicit: true };
    expect(recordingCensorship(conflicting)).toBe('unknown');
    const result = rankSoundCloudCandidates(track, [candidate(conflicting)], { confirmed: { trackId: track.id, sourceId: 'sc:123' } });
    expect(result.selectedId).toBeUndefined();
    expect(result.candidates[0].reasons).toContain('metadata-conflict');
  });
});

describe('VK source hints are not recording provenance', () => {
  it('keeps old/missing metadata unknown and uses only explicit absence as a hint', () => {
    expect(vkSourceHint({ source: 'vk' })).toBe('unknown');
    expect(vkSourceHint({ source: 'vk', artistRefs: [] })).toBe('unknown');
    expect(vkSourceHint({ source: 'vk', artistCard: 'unknown' })).toBe('unknown');
    expect(vkSourceHint({ source: 'vk', artistCard: 'absent' })).toBe('missing-artist-card');
  });
  it('keeps positively linked catalog tracks on the normal path unless actually known problematic', () => {
    const linked = { source: 'vk' as const, artistRefs: [{ id: '123', name: 'Artist' }] };
    expect(vkSourceHint(linked)).toBe('catalog-linked');
    expect(vkSourceHint(linked, { knownProblematic: true })).toBe('known-problematic');
    expect(vkSourceHint({ source: 'local' }, { knownProblematic: true })).toBe('local');
  });
});
