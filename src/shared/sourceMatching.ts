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
const ornament = /^(?:official\s+(?:(?:music|lyric)\s+)?(?:audio|video)|lyric(?:s|\s+video)?|audio|visuali[sz]er|официальн(?:ое|ый)\s+(?:аудио|видео))$/iu;
const explicitLabel = /^(?:explicit|uncensored|un[ -]?censored|dirty(?:\s+version)?|без\s+цензуры)$/iu;
const cleanLabel = /^(?:clean(?:\s+version)?|censored|цензурн(?:ая|ый|ое)(?:\s+версия)?)$/iu;
const featureLabel = /^(?:feat\.?|ft\.?|featuring)\s+(.+)$/iu;
const validId = (value: string) => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const durationKnown = (value: number) => Number.isFinite(value) && value > 0;

/** No transliteration, substring artist matching, or fuzzy identity merging. */
export function normalizeRecordingText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
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
    if (feature) { features.push(normalizeRecordingText(feature[1])); return true; }
    if (explicitLabel.test(text)) { labels.add('explicit'); return true; }
    if (cleanLabel.test(text)) { labels.add('clean'); return true; }
    if (ornament.test(text)) return true;
    if (variantMarker.test(text)) { variants.push(normalizeRecordingText(text)); return true; }
    return false;
  };
  let title = metadata.title.replace(/\(([^()]*)\)|\[([^\[\]]*)\]/gu, (whole, round: string | undefined, square: string | undefined) => classify(round ?? square ?? '') ? ' ' : whole);
  // A spaced separator identifies a descriptor without splitting names such as AC/DC.
  title = title.replace(/\s+[-–—|]\s+([^|]+)$/u, (whole, suffix: string) => classify(suffix) ? ' ' : whole);
  if (metadata.version?.trim()) classify(metadata.version) || variants.push(normalizeRecordingText(metadata.version));
  const artistParts = metadata.artist.split(/\s+(?:feat\.?|ft\.?|featuring)\s+/iu);
  const primaryArtist = normalizeRecordingText(artistParts.shift() ?? '');
  features.push(...artistParts.map(normalizeRecordingText));
  const censorship: Censorship = labels.size === 1 ? [...labels][0] : 'unknown';
  return {
    title: normalizeRecordingText(title),
    artist: [primaryArtist, ...[...new Set(features.filter(Boolean))].sort()].join('|'),
    primaryArtist,
    version: [...new Set(variants.filter(Boolean))].sort().join('|'),
    censorship,
    conflict: labels.size > 1,
    isrc: isrc(metadata.isrc),
  };
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
  const wanted = metadataIdentity(track);
  const confirmedId = options.confirmed?.trackId === track.id ? options.confirmed.sourceId : undefined;
  const ranked = candidates.map((candidate): RankedSourceCandidate<T> => {
    const identity = metadataIdentity(candidate), reasons: SourceMatchReason[] = [];
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
    if (identity.title === wanted.title) score += 35;
    else if (tokenSimilarity(identity.title, wanted.title) >= .75) { score += 12; review('title'); }
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
