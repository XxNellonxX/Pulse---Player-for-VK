import type { Track } from './contracts'

export type VkArtistRef = { id: string; name: string; photo?: string; followed?: boolean; canFollow?: boolean }
export type ArtistRelease = { id: string; ownerId: number; playlistId: number; title: string; artist: string; artistRefs?: VkArtistRef[]; artwork?: string; kind: 'album' | 'ep' | 'single' | 'compilation' | 'release'; year?: number; trackCount: number; plays?: number; releasedAt?: number }
export type ArtistProfile = VkArtistRef & { bio?: string; listeners?: number; followers?: number; tracks: Track[]; releases: ArtistRelease[]; checkedAt: number }
export type ArtistMusicRequest = { action: 'resolve' | 'artist' | 'release' | 'updates' | 'follow' | 'snippets' | 'snippet'; query?: string; artistId?: string; releaseId?: string; trackId?: string; follow?: boolean; force?: boolean }
export type ArtistMusicResult = { artists?: VkArtistRef[]; artist?: ArtistProfile; releases?: ArtistRelease[]; release?: ArtistRelease; tracks?: Track[]; clip?: { trackId: string; from: number; to: number }; checkedAt: number; cached?: boolean; hasMore?: boolean; message?: string }

export type ArtistViewProps = { request: ArtistMusicRequest; connected: boolean; library: Track[]; currentId?: string | null; playing?: boolean; addedTrackIds?: Set<string>; onNavigate: (request: ArtistMusicRequest) => void; onPlay: (track: Track, context: Track[], fullVersion?: boolean) => void; onAdd: (track: Track) => Promise<boolean | void> | void; onSnippet: (track: Track, from: number, to: number) => void; onConnect: () => void }
