import type { Track } from './contracts'

/** Provider durations must be converted to seconds at the IPC boundary. */
export type RecordingMetadata = Pick<Track, 'title' | 'artist' | 'duration'> & {
  version?: string;
  explicit?: boolean | null;
  isrc?: string;
};

export type SoundCloudCandidate = RecordingMetadata & {
  id: string;
  permalinkUrl?: string;
  artworkUrl?: string;
  streamable?: boolean;
};
export type SoundCloudBinding = SoundCloudCandidate & { selection?: 'user' | 'metadata' };

export type Censorship = 'explicit' | 'clean' | 'unknown';
export type SourceMatchQuality = 'exact' | 'review' | 'mismatch';
export type SourceMatchReason = 'artist' | 'title' | 'duration' | 'duration-unknown' |
  'version' | 'censorship' | 'censorship-unknown' | 'metadata-conflict' | 'isrc' |
  'unavailable' | 'invalid-id' | 'invalid-metadata';

export type RankedSourceCandidate<T extends SoundCloudCandidate = SoundCloudCandidate> = {
  candidate: T;
  /** Exact means metadata agreement, never proof from an audio fingerprint. */
  quality: SourceMatchQuality;
  score: number;
  reasons: SourceMatchReason[];
  durationDifference?: number;
  censorship: Censorship;
  confirmed: boolean;
};

export type ConfirmedSourceBinding = { trackId: string; sourceId: string };
export type SourceMatchingOptions = {
  preferExplicit?: boolean;
  confirmed?: ConfirmedSourceBinding;
};
export type RankedSourceResult<T extends SoundCloudCandidate = SoundCloudCandidate> = {
  candidates: RankedSourceCandidate<T>[];
  status: 'confirmed' | 'unique' | 'ambiguous' | 'none';
  /** Only an existing explicit user confirmation may select a source. */
  selectedId?: string;
  /** A proposal is not a user-confirmed binding. */
  suggestedId?: string;
};

const variantMarker = /\b(?:live|remix|remaster(?:ed)?|cover|instrumental|acapella|a\s+cappella|karaoke|acoustic|demo|edit|extended|nightcore|sped[\s-]*up|slowed(?:[\s-]*down)?|reverb|original\s+mix)\b|(?:ремикс|ремастер|концерт|кавер|замедлен|ускорен)/iu;
const ornament = /^(?:official\s+(?:(?:music|lyric)\s+)?(?:audio|video)|lyric(?:s|\s+video)?|audio|visuali[sz]er|официальн(?:ое|ый)\s+(?:аудио|видео)|все\s+площадки)$/iu;
const explicitLabel = /^(?:explicit|uncensored|un[ -]?censored|dirty(?:\s+version)?|без\s+цензуры)$/iu;
const cleanLabel = /^(?:clean(?:\s+version)?|censored|цензурн(?:ая|ый|ое)(?:\s+версия)?)$/iu;
const featureLabel = /^(?:feat\.?|ft\.?|featuring)\s+(.+)$/iu;
const producerLabel = /^(?:prod\.?|p\.|produced\s+by|прод\.?|продюсер)\s*[:.]?\s+\S.+$/iu;
const decorativeFace = /^[\s„“”"'•·.<>^~_\-\\/;:ᵔᴗω♡♥☆★✧✦＊*°˃˂̵๑و]+$/u;
const creditEditionWord = /live|remix|remaster|cover|instrumental|acapella|karaoke|acoustic|demo|edit|extended|nightcore|sped|slowed|reverb|mix|alternate|take|version|clean|explicit|censor|dirty|ремикс|ремастер|концерт|кавер|замедлен|ускорен|верси|цензур/iu;
const editionTerms = new Set(['mono', 'stereo', 'radio', 'chopped', 'chop', 'pitched', 'pitch', 'part', 'pt', 'vip', 'dub', 'vol', 'volume', 'side', 'reprise', 'rework', 'revision', 'alt', 'album', 'studio', 'bootleg', 'mashup', '8d', '3d', 'spatial', 'digital', 'original', 'instrumental', 'vocals', 'vocal', 'rehearsal', 'session', 'alternate', 'remaster', 'remastered', 'remix', 'mix', 'take', 'bass', 'boost', 'boosted', 'earrape', 'muffled', 'distorted', 'distortion', 'binaural', 'surround']);
const editionPhrase = /без\s+(?:мата|ругательств|(?:нецензурной|ненормативной)\s+лексики)|no\s+(?:swearing|profanity)|family\s+friendly/iu;
const validId = (value: string) => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const durationKnown = (value: number) => Number.isFinite(value) && value > 0;

/** No transliteration, substring artist matching, or fuzzy identity merging. */
export function normalizeRecordingText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
}

function editionIntent(value: string): boolean {
  // Only the edition classifier folds accents. Artist/title identities retain
  // their stricter normalizer. Unicode compatibility letters, punctuation and
  // accents must not disguise a known edition or a numbered/roman take.
  const folded = value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const words = normalizeRecordingText(folded).split(' ').filter(Boolean);
  return creditEditionWord.test(folded) || editionPhrase.test(normalizeRecordingText(folded)) || words.some(word => editionTerms.has(word) ||
    /^(?:\d+|[ivxlcdm]+)$/u.test(word) || /^(?:part|pt|vol|volume|side|take|version|v)\d+$/u.test(word));
}

function normalizeRecordingTitle(value: string): string {
  const text = normalizeRecordingText(value);
  if (text) return text;
  const normalized = value.normalize('NFKC');
  // Some recordings have emoji-only names. Keep their exact sequence and
  // composition instead of treating every such title as empty or equivalent.
  // Variation selectors and punctuation only affect presentation; ZWJ, skin
  // modifiers, regional flags and subdivision tags remain identity evidence.
  if (!/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(normalized)) return '';
  return [...normalized].filter(character => /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200d\u{e0020}-\u{e007f}]/u.test(character)).join('');
}

/** Delimiters must be explicit: never split substrings of names such as Xzibit. */
function artistNames(value: string): string[] {
  return value.split(/\s*,\s*|\s+[x×&]\s+|\s+(?:feat\.?|ft\.?|featuring)\s+|\s+(?=#[\p{L}\p{N}])/iu)
    .map(normalizeRecordingText).filter(Boolean);
}

function mixedScriptTitle(value: string): string | undefined {
  // This only suggests review for visually similar mixed-script words. It is
  // never used as recording identity, for artist names, or for automatic binds.
  if (!/\p{Script=Cyrillic}/u.test(value) || !/[a-z]/iu.test(value)) return undefined;
  const lookalikes: Record<string, string> = { a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у' };
  return value.replace(/[aceopxy]/gu, letter => lookalikes[letter]);
}

function isrc(value?: string): string | undefined {
  const normalized = value?.replace(/[\s-]/gu, '').toUpperCase();
  return normalized && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/u.test(normalized) ? normalized : undefined;
}

function metadataIdentity(metadata: RecordingMetadata) {
  const variants: string[] = [];
  const features: string[] = [];
  const labels = new Set<Censorship>();
  // A missing explicit flag (or false) is not evidence of a censored edition.
  if (metadata.explicit === true) labels.add('explicit');
  const classify = (value: string): boolean => {
    const text = value.trim();
    const feature = text.match(featureLabel);
    if (feature) { features.push(feature[1]); return true; }
    if (explicitLabel.test(text)) { labels.add('explicit'); return true; }
    if (cleanLabel.test(text)) { labels.add('clean'); return true; }
    if (ornament.test(text)) return true;
    if (variantMarker.test(text)) { variants.push(normalizeRecordingText(text)); return true; }
    if (producerLabel.test(text) && !editionIntent(text)) return true;
    if (text.length >= 3 && decorativeFace.test(text)) return true;
    return false;
  };
  let title = metadata.title.replace(/\(([^()]*)\)|\[([^\[\]]*)\]/gu, (whole, round: string | undefined, square: string | undefined) => classify(round ?? square ?? '') ? ' ' : whole);
  // A spaced separator identifies a descriptor without splitting names such as AC/DC.
  title = title.replace(/\s+[-–—|]\s+([^|]+)$/u, (whole, suffix: string) => classify(suffix) ? ' ' : whole);
  // A narrowly recognized uploader instruction is presentation, not a take or
  // a contributor. Require an explicit boundary; never trim an arbitrary tail.
  title = title.replace(/(?:^|[\s\\/|#])не\s*форс(?:ить|ите)?\s*$/iu, ' ');
  if (metadata.version?.trim()) classify(metadata.version) || variants.push(normalizeRecordingText(metadata.version));
  const names = artistNames(metadata.artist);
  const primaryArtist = names[0] ?? '';
  const contributors = [...new Set([...names, ...features.flatMap(artistNames)].filter(Boolean))].sort();
  const censorship: Censorship = labels.size === 1 ? [...labels][0] : 'unknown';
  return {
    title: normalizeRecordingTitle(title),
    artist: contributors.join('|'),
    primaryArtist,
    version: [...new Set(variants.filter(Boolean))].sort().join('|'),
    censorship,
    conflict: labels.size > 1,
    isrc: isrc(metadata.isrc),
    titleReview: false,
  };
}

function titleContributorIdentity(metadata: RecordingMetadata, corroboratedArtists: string) {
  // A trailing "+alias" is a contributor only when a provider's explicit
  // artist list independently contains the complete aggregate. It cannot turn
  // an arbitrary plus-sign subtitle or a different collaborator into a match.
  const match = metadata.title.match(/^(.+?)\s+\+\s*([^+]+)$/u);
  if (!match || !match[1].trim() || match[2].trim().length > 80 || editionIntent(match[2])) return undefined;
  const aliases = artistNames(match[2]);
  if (!aliases.length || aliases.length > 3) return undefined;
  const base = metadataIdentity({ ...metadata, title: match[1].trim() });
  const aggregate = [...new Set([...base.artist.split('|'), ...aliases].filter(Boolean))].sort().join('|');
  return aggregate === corroboratedArtists ? { ...base, artist: aggregate } : undefined;
}

function candidateIdentity(candidate: RecordingMetadata, wanted: ReturnType<typeof metadataIdentity>) {
  const direct = metadataIdentity(candidate);
  if (direct.artist === wanted.artist && direct.title === wanted.title) return direct;
  const contributed = titleContributorIdentity(candidate, wanted.artist);
  if (contributed?.artist === wanted.artist && contributed.title === wanted.title) return contributed;
  // SoundCloud premiere channels often put the performers in the title. Keep
  // the provider's original title/artist on the candidate; only use the rigid
  // structure as additional matching evidence when BOTH requested fields agree.
  const title = candidate.title.replace(/^\s*TRACK\s+PREMIERE\s*:\s*/iu, '');
  const parts = title.split(/\s+[-–—]\s+/u);
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
    const embedded = metadataIdentity({ ...candidate, artist: parts[0], title: parts[1] });
    if (embedded.artist === wanted.artist && embedded.title === wanted.title) return embedded;
  }
  // An unlabelled parenthesized suffix may be a producer credit OR a named
  // edition. Surface the exact base title for explicit review, never auto-bind.
  const baseTitle = candidate.title.replace(/\s*\([^()]+\)\s*$/u, '').trim();
  if (baseTitle !== candidate.title.trim() && direct.artist === wanted.artist) {
    const base = metadataIdentity({ ...candidate, title: baseTitle });
    if (base.title === wanted.title && !direct.version && base.version === wanted.version) {
      const suffix = candidate.title.match(/\(([^()]+)\)\s*$/u)?.[1] ?? '';
      const aliases = suffix.split(',').map(alias => alias.trim());
      // A compact comma-separated producer list is a recognizable credit
      // convention. Known edition semantics and numbered takes stay distinct;
      // this bounded metadata heuristic is still not fingerprint proof. Artist,
      // title, duration, version, censorship and ISRC checks remain independent.
      const producerList = aliases.length >= 2 && aliases.length <= 4 && aliases.every(alias =>
        /^\p{L}[\p{L}\p{N}_.@$-]{0,31}$/u.test(alias) && !editionIntent(alias));
      return { ...base, titleReview: !producerList };
    }
  }
  return direct;
}

export function recordingCensorship(metadata: RecordingMetadata): Censorship {
  return metadataIdentity(metadata).censorship;
}

function tokenSimilarity(first: string, second: string): number {
  const a = new Set(first.split(' ').filter(Boolean)), b = new Set(second.split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  const shared = [...a].filter(token => b.has(token)).length;
  return 2 * shared / (a.size + b.size);
}

/** Absence of artist cards is a discovery hint, not proof of an external upload. */
export function vkSourceHint(track: Pick<Track, 'source' | 'artistRefs'> & { artistCard?: 'present' | 'absent' | 'unknown' }, options: { knownProblematic?: boolean } = {}): 'local' | 'known-problematic' | 'missing-artist-card' | 'catalog-linked' | 'unknown' {
  if (track.source !== 'vk') return 'local';
  if (options.knownProblematic) return 'known-problematic';
  if (track.artistRefs?.some(ref => ref.id.trim()) || track.artistCard === 'present') return 'catalog-linked';
  return track.artistCard === 'absent' ? 'missing-artist-card' : 'unknown';
}

export function rankSoundCloudCandidates<T extends SoundCloudCandidate>(
  track: RecordingMetadata & Pick<Track, 'id'>,
  candidates: readonly T[],
  options: SourceMatchingOptions = {},
): RankedSourceResult<T> {
  const originalWanted = metadataIdentity(track);
  const confirmedId = options.confirmed?.trackId === track.id ? options.confirmed.sourceId : undefined;
  const ranked = candidates.map((candidate): RankedSourceCandidate<T> => {
    // The wanted record may itself put a contributor in the title. Only the
    // other provider's explicit artist field may corroborate this expansion.
    const candidateArtists = [...new Set(artistNames(candidate.artist))].sort().join('|');
    const wanted = titleContributorIdentity(track, candidateArtists) ?? originalWanted;
    const identity = candidateIdentity(candidate, wanted), reasons: SourceMatchReason[] = [];
    let quality: SourceMatchQuality = 'exact', score = 0;
    const review = (reason: SourceMatchReason) => { reasons.push(reason); if (quality === 'exact') quality = 'review'; };
    const mismatch = (reason: SourceMatchReason) => { reasons.push(reason); quality = 'mismatch'; };
    if (!validId(candidate.id)) mismatch('invalid-id');
    if (!wanted.title || !wanted.primaryArtist || !identity.title || !identity.primaryArtist) mismatch('invalid-metadata');
    if (candidate.streamable === false) mismatch('unavailable');
    if (identity.conflict || wanted.conflict) mismatch('metadata-conflict');
    if (identity.artist === wanted.artist) score += 30;
    else if (identity.primaryArtist === wanted.primaryArtist) { score += 10; review('artist'); }
    else mismatch('artist');
    if (identity.title === wanted.title) { score += 35; if (identity.titleReview) review('title'); }
    else if (tokenSimilarity(identity.title, wanted.title) >= .75 ||
      mixedScriptTitle(identity.title) === wanted.title || mixedScriptTitle(wanted.title) === identity.title) { score += 12; review('title'); }
    else mismatch('title');
    if (identity.version === wanted.version) score += 15;
    else mismatch('version');
    let durationDifference: number | undefined;
    if (durationKnown(track.duration) && durationKnown(candidate.duration)) {
      durationDifference = Math.abs(track.duration - candidate.duration);
      const exactTolerance = Math.min(3, Math.max(2, track.duration * .01));
      if (durationDifference <= exactTolerance) score += 15 - durationDifference;
      else if (durationDifference <= Math.max(8, track.duration * .05)) { score += 3; review('duration'); }
      else mismatch('duration');
    } else review('duration-unknown');
    if (wanted.isrc && identity.isrc) {
      if (wanted.isrc === identity.isrc) score += 10;
      else mismatch('isrc');
    }
    if (wanted.censorship !== 'unknown') {
      if (identity.censorship === 'unknown') review('censorship-unknown');
      else if (identity.censorship !== wanted.censorship) mismatch('censorship');
    }
    // This preference changes order only. Unknown is never described as censored.
    if (options.preferExplicit && identity.censorship === 'explicit') score += 2;
    const confirmed = confirmedId === candidate.id && validId(candidate.id) &&
      candidate.streamable !== false && identity.title.length > 0 && identity.primaryArtist.length > 0 && !identity.conflict;
    return { candidate, quality, score: Math.round(score * 100) / 100, reasons: [...new Set(reasons)], durationDifference, censorship: identity.censorship, confirmed };
  });
  const qualityOrder: Record<SourceMatchQuality, number> = { exact: 0, review: 1, mismatch: 2 };
  ranked.sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || qualityOrder[a.quality] - qualityOrder[b.quality] || b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
  // Search pages may repeat a provider ID. They must not manufacture ambiguity.
  const unique = ranked.filter((item, index) => ranked.findIndex(other => other.candidate.id === item.candidate.id) === index);
  const confirmed = unique.find(item => item.confirmed);
  if (confirmed) return { candidates: unique, status: 'confirmed', selectedId: confirmed.candidate.id };
  const proposals = unique.filter(item => item.quality !== 'mismatch');
  if (!proposals.length) return { candidates: unique, status: 'none' };
  // Two plausible versions always require a choice; preference is not identity.
  if (proposals.length > 1) return { candidates: unique, status: 'ambiguous' };
  return { candidates: unique, status: 'unique', suggestedId: proposals[0].candidate.id };
}
