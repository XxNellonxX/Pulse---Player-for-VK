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
  it('matches the same complete collaborator set across order and explicit separators', () => {
    const wanted = { ...track, title: 'Untitled', artist: '#мертвый, тёмный принц, самик' };
    for (const artist of ['самик & #мёртвый & тёмный принц', 'тёмный принц x самик x #мертвый']) {
      expect(rankSoundCloudCandidates(wanted, [candidate({ title: 'Untitled', artist })]).candidates[0].quality).toBe('exact');
    }
    expect(rankSoundCloudCandidates(wanted, [candidate({ title: 'Untitled', artist: 'тёмный принц, самик' })]).candidates[0].quality).not.toBe('exact');
  });

  it('matches the actual haru/hash artist boundary without changing the Latin-c title', () => {
    const wanted = { ...track, title: 'cвиньи', artist: 'haru’ #мертвый', duration: 94 };
    const found = candidate({ title: 'cвиньи', artist: 'haru’, #мёртвый', duration: 93.617 });
    expect(rankSoundCloudCandidates(wanted, [found]).candidates[0].quality).toBe('exact');
    expect(found.artist).toBe('haru’, #мёртвый');
  });

  it('extracts rigid premiere title evidence while retaining provider attribution', () => {
    const wanted = { ...track, title: 'blue', artist: 'safetypleace, arkale, neea', duration: 149 };
    const found = Object.freeze(candidate({ id: '2405927967', title: 'TRACK PREMIERE: safetypleace, arkale, Neea - blue', artist: 'СТВОЛ', duration: 148.676 }));
    const ranked = rankSoundCloudCandidates(wanted, [found]);
    expect(ranked.candidates[0].quality).toBe('exact');
    expect(ranked.candidates[0].candidate).toBe(found);
    expect(found.artist).toBe('СТВОЛ');
    expect(found.title).toBe('TRACK PREMIERE: safetypleace, arkale, Neea - blue');
    expect(rankSoundCloudCandidates(wanted, [candidate({ ...found, title: 'TRACK PREMIERE: Different Artist - blue' })]).candidates[0].quality).toBe('mismatch');
    expect(rankSoundCloudCandidates(wanted, [candidate({ ...found, title: `${found.title} (Live)` })]).candidates[0].quality).toBe('mismatch');
  });

  it('keeps mixed Latin/Cyrillic visual title lookalikes for review only', () => {
    const wanted = { ...track, title: 'свиньи', artist: 'haru’ #мертвый', duration: 94 };
    const result = rankSoundCloudCandidates(wanted, [candidate({ title: 'cвиньи', artist: 'haru’, #мёртвый', duration: 93.617 })]);
    expect(result.candidates[0].quality).toBe('review');
    expect(result.candidates[0].reasons).toContain('title');
    expect(normalizeRecordingText('cвиньи')).not.toBe(normalizeRecordingText('свиньи'));
    expect(rankSoundCloudCandidates(wanted, [candidate({ title: 'свиньи', artist: 'hаru’, #мертвый', duration: 94 })]).candidates[0].quality).not.toBe('exact');
  });

  it('does not split x inside artist names or AC/DC', () => {
    for (const artist of ['Xzibit', 'AC/DC']) expect(rankSoundCloudCandidates({ ...track, artist }, [candidate({ artist })]).candidates[0].quality).toBe('exact');
  });

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

describe('uploader credits and decoration preserve recording constraints', () => {
  const nuisance = { id: 'vk-upload-a', title: 'все сложно', artist: 'nuisance', duration: 156 };
  const quasari = { id: 'vk-upload-b', title: 'МальчикТемныйНачальник', artist: 'касари@_~', duration: 134 };
  it('recognizes a compact producer list while retaining the original public title', () => {
    const source = { id: '2375033984', title: 'все сложно (elyth,doremio)', artist: 'nuisance', duration: 156.404, streamable: true };
    const result = rankSoundCloudCandidates(nuisance, [source]);
    expect(result).toMatchObject({ status: 'unique', suggestedId: source.id });
    expect(result.candidates[0].quality).toBe('exact');
    expect(result.candidates[0].candidate.title).toBe(source.title);
  });
  it('ignores explicit production credit, kaomoji and a separated no-promotion instruction', () => {
    const source = { id: '2367250382', title: 'МальчикТемныйНачальник\\\\\\(„• ᴗ •„)неФорс (прод. NOIRNOVEL)', artist: 'касари@_~', duration: 133.851, streamable: true };
    expect(rankSoundCloudCandidates(quasari, [source]).candidates[0].quality).toBe('exact');
  });
  it.each(['Live', 'DJ Remix', 'Slowed', 'Acoustic', 'Radio Edit'])('does not hide a %s edition behind credits', edition => {
    const source = { id: 'other', title: `все сложно (${edition}) (elyth,doremio)`, artist: nuisance.artist, duration: nuisance.duration };
    expect(rankSoundCloudCandidates(nuisance, [source]).candidates[0].quality).not.toBe('exact');
  });
  it('retains censorship labels independently of the producer list', () => {
    for (const [label, censorship] of [['Clean', 'clean'], ['Explicit', 'explicit'], ['без цензуры', 'explicit']] as const) {
      const source = { id: 'other', title: `все сложно (${label}) (elyth,doremio)`, artist: nuisance.artist, duration: nuisance.duration };
      expect(recordingCensorship(source)).toBe(censorship);
      const wanted = censorship === 'clean' ? { ...nuisance, explicit: true } : { ...nuisance, title: 'все сложно (Clean)' };
      expect(rankSoundCloudCandidates(wanted, [source]).candidates[0].quality).toBe('mismatch');
    }
  });
  it.each(['djremix,other', 'clean,other', 'explicit,other', 'live,other', 'slowed_down,other', 'alternate,original', '123,456',
    'mono,radio', 'chopped,pitched', 'Part,II', 'VIP,Dub', 'stéréo,elyth', '𝖒𝖔𝖓𝖔,doremio', 'vol2,elyth', 'Ⅳ,doremio', '8d,elyth', 'digital,doremio', 'rework,elyth', 'spatial,doremio',
  ])('does not auto-bind an edition or numeric list (%s)', suffix => {
    const source = { id: 'other', title: `все сложно (${suffix})`, artist: nuisance.artist, duration: nuisance.duration };
    expect(rankSoundCloudCandidates(nuisance, [source]).candidates[0].quality).not.toBe('exact');
  });
  it('keeps single unknown subtitles for review instead of removing arbitrary suffixes', () => {
    const source = { id: 'other', title: 'все сложно (alternate recording 7)', artist: nuisance.artist, duration: nuisance.duration };
    expect(rankSoundCloudCandidates(nuisance, [source]).candidates[0].quality).toBe('review');
  });
  it('keeps producer-list proposals subject to performer, duration, ISRC and version evidence', () => {
    const source = { id: 'other', title: 'все сложно (elyth,doremio)', artist: nuisance.artist, duration: nuisance.duration };
    for (const change of [{ artist: 'nuisance fan' }, { duration: 180 }, { version: 'Different recording' }]) {
      expect(rankSoundCloudCandidates(nuisance, [{ ...source, ...change }]).candidates[0].quality).toBe('mismatch');
    }
    expect(rankSoundCloudCandidates(nuisance, [{ ...source, duration: 162 }]).candidates[0].quality).toBe('review');
    expect(rankSoundCloudCandidates({ ...nuisance, isrc: 'USABC2612345' }, [{ ...source, isrc: 'USABC2612346' }]).candidates[0].quality).toBe('mismatch');
    expect(rankSoundCloudCandidates({ ...nuisance, explicit: true }, [source]).candidates[0].quality).toBe('review');
  });
  it('does not let an explicit production label conceal known edition semantics', () => {
    for (const label of ['prod. mono', 'p. radio', 'прод. stéréo', 'produced by VIP', 'p. Ⅳ', 'prod. take2', 'prod. 3d', 'prod. side-b']) {
      const source = { id: 'other', title: `все сложно (${label})`, artist: nuisance.artist, duration: nuisance.duration };
      expect(rankSoundCloudCandidates(nuisance, [source]).candidates[0].quality).not.toBe('exact');
    }
  });
  it('leaves two credited uploads ambiguous, independent of producer-list normalization', () => {
    const first = { id: 'a', title: 'все сложно (elyth,doremio)', artist: nuisance.artist, duration: nuisance.duration };
    expect(rankSoundCloudCandidates(nuisance, [first, { ...first, id: 'b' }]).status).toBe('ambiguous');
  });
  it('does not hide a changed version behind the same promotional decoration', () => {
    for (const suffix of ['(Live)', '(Slowed)', '(prod. DJ Remix)', '(prod. DJ Clean)']) {
      const source = { id: 'other', title: `МальчикТемныйНачальник\\\\(„• ᴗ •„)неФорс ${suffix}`, artist: quasari.artist, duration: quasari.duration };
      expect(rankSoundCloudCandidates(quasari, [source]).candidates[0].quality).not.toBe('exact');
    }
    const clean = { id: 'other', title: 'МальчикТемныйНачальник\\\\(„• ᴗ •„)неФорс (Clean)', artist: quasari.artist, duration: quasari.duration };
    expect(recordingCensorship(clean)).toBe('clean');
    expect(rankSoundCloudCandidates({ ...quasari, explicit: true }, [clean]).candidates[0].quality).toBe('mismatch');
  });
});

describe('corroborated contributor notation and distribution labels', () => {
  const wanted = { id: 'vk-plus', title: 'упс + whoisnewell', artist: 'плачьтенадмоимтелом', duration: 121 };
  const source = { id: '2396878518', title: 'упс + whoisnewell', artist: 'плачьтенадмоимтелом, whoisnewell', duration: 121, streamable: true };
  it('recognizes a title contributor when the other provider lists the complete artist set', () => {
    expect(rankSoundCloudCandidates(wanted, [source]).candidates[0].quality).toBe('exact');
    expect(rankSoundCloudCandidates(wanted, [{ ...source, title: 'упс' }]).candidates[0].quality).toBe('exact');
  });
  it('recognizes a candidate title contributor already corroborated by the requested artists', () => {
    const track = { id: 'vk-glass', title: 'стеклянный дом', artist: 'creepypastauser, akiko!', duration: 98 };
    const candidate = { id: '2358836837', title: 'стеклянный дом +akiko!', artist: track.artist, duration: 97.697 };
    expect(rankSoundCloudCandidates(track, [candidate]).candidates[0].quality).toBe('exact');
    expect(candidate.title).toBe('стеклянный дом +akiko!');
  });
  it.each([
    { artist: 'плачьтенадмоимтелом, other' },
    { artist: 'плачьтенадмоимтелом', title: 'упс' },
    { title: 'упс + other' },
    { title: 'упс + whoisnewell', artist: 'other, whoisnewell' },
  ])('does not remove a plus subtitle without matching contributor evidence: %j', change => {
    expect(rankSoundCloudCandidates(wanted, [{ ...source, ...change }]).candidates[0].quality).not.toBe('exact');
  });
  it('does not normalize an uncorroborated plus sign in a recording title', () => {
    const track = { id: 'vk-math', title: 'icon + other', artist: 'icon', duration: 100 };
    expect(rankSoundCloudCandidates(track, [{ id: 'sc-math', title: 'icon', artist: 'icon', duration: 100 }]).candidates[0].quality).toBe('mismatch');
  });
  it('keeps independently checked recording constraints on a corroborated contribution', () => {
    for (const change of [{ duration: 160 }, { version: 'Live' }, { title: 'упс + whoisnewell (Slowed)' }]) {
      expect(rankSoundCloudCandidates(wanted, [{ ...source, ...change }]).candidates[0].quality).not.toBe('exact');
    }
    const clean = { ...source, title: 'упс + whoisnewell (Clean)' };
    expect(rankSoundCloudCandidates({ ...wanted, explicit: true }, [clean]).candidates[0].quality).toBe('mismatch');
    expect(rankSoundCloudCandidates(wanted, [source, { ...source, id: 'other-upload' }]).status).toBe('ambiguous');
  });
  it('recognizes only the exact distribution presentation label', () => {
    const track = { id: 'vk-platforms', title: 'она утянет меня', artist: 'килеан', duration: 94 };
    const candidate = { id: '2368369724', title: 'она утянет меня [все площадки]', artist: track.artist, duration: 94.04 };
    expect(rankSoundCloudCandidates(track, [candidate]).candidates[0].quality).toBe('exact');
    for (const title of ['она утянет меня [все площадки remix]', 'она утянет меня [все площадки version 2]', 'она утянет меня [все площадки] (Live)']) {
      expect(rankSoundCloudCandidates(track, [{ ...candidate, title }]).candidates[0].quality).not.toBe('exact');
    }
  });
  it('leaves unverified single-alias suffixes for review', () => {
    const track = { id: 'vk-unknown-credit', title: 'все сложно', artist: 'nuisance', duration: 156 };
    for (const alias of ['realdelone', 'hloex']) {
      expect(rankSoundCloudCandidates(track, [{ id: alias, title: `все сложно (${alias})`, artist: track.artist, duration: 156 }]).candidates[0].quality).toBe('review');
    }
  });
  it('recognizes a separated p. production credit while retaining edition guards', () => {
    const track = { id: 'vk-details', title: 'детали', artist: 'dirtyspark', duration: 68 };
    const candidate = { id: '2342026691', title: 'детали (p. nightw1ll)', artist: track.artist, duration: 67.433 };
    expect(rankSoundCloudCandidates(track, [candidate]).candidates[0].quality).toBe('exact');
    for (const suffix of ['p.nightw1ll', 'p nightw1ll', 'p. nightw1ll remix', 'p. clean', 'p. nightw1ll alternate']) {
      expect(rankSoundCloudCandidates(track, [{ ...candidate, title: `детали (${suffix})` }]).candidates[0].quality).not.toBe('exact');
    }
  });
});

describe('emoji-only recording titles', () => {
  const track = { id: 'vk-emoji', title: '🕊🕊🕊', artist: 'vanchss', duration: 107 };
  const candidate = { id: '2289798155', title: '🕊️🕊️🕊️...', artist: 'vanchss', duration: 106.997 };
  it('keeps the exact meaningful emoji sequence while ignoring presentation selectors and terminal punctuation', () => {
    expect(rankSoundCloudCandidates(track, [candidate]).candidates[0].quality).toBe('exact');
    expect(candidate.title).toBe('🕊️🕊️🕊️...');
  });
  it.each(['🕊', '🕊🕊', '🕊🕊🕊🕊', '🕊🦅🕊', '...', '!!!'])('does not merge different or empty emoji identities: %s', title => {
    expect(rankSoundCloudCandidates(track, [{ ...candidate, title }]).candidates[0].quality).toBe('mismatch');
  });
  it.each([
    ['👍', '👍🏻'], ['👍🏻', '👍🏿'], ['👨‍👩‍👧', '👨👩👧'], ['👨‍👩‍👧', '👨‍👨‍👧'], ['🇷🇺', '🇺🇸'],
    ['🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}', '🏴\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}'],
  ])('preserves modifiers, flags and family composition (%s / %s)', (title, other) => {
    expect(rankSoundCloudCandidates({ ...track, title }, [{ ...candidate, title: other }]).candidates[0].quality).toBe('mismatch');
  });
  it('keeps punctuation-only titles invalid and does not relax artist normalization', () => {
    expect(rankSoundCloudCandidates({ ...track, title: '...' }, [{ ...candidate, title: '...' }]).candidates[0].quality).toBe('mismatch');
    expect(rankSoundCloudCandidates({ ...track, artist: '🕊' }, [{ ...candidate, artist: '🕊' }]).candidates[0].quality).toBe('mismatch');
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
