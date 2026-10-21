import type { ArtistMusicRequest, ArtistMusicResult } from './artists'
import type { EqualizerSettings } from './equalizer'
export type RemoteTrack = { ownerId: number; audioId: number; accessKey?: string; inLibrary?: boolean; searchResult?: boolean }
export type RemotePlaylist = { ownerId: number; playlistId: number; accessKey?: string }
export type Track = {
  id: string; title: string; artist: string; album: string; duration: number;
  artwork?: string; url: string; source: 'local' | 'vk'; addedAt: number;
  available: boolean; remote?: RemoteTrack;
  artistRefs?: Array<{ id: string; name: string }>;
};
export type Playlist = {
  id: string; title: string; trackIds: string[]; createdAt: number;
  remote?: RemotePlaylist; description?: string; artwork?: string; syncedAt?: number;
  contentUnavailable?: boolean; remoteTrackCount?: number;
};
export type AppSettings = {
  theme: 'dark' | 'light' | 'system' | 'high-contrast'; style: 'minimal' | 'compact' | 'album' | 'soft';
  palette?: string;
  accent: string; density: 'comfortable' | 'compact'; textScale: number;
  reducedMotion: boolean; volume: number; repeat: 'off' | 'all' | 'one';
  shuffle: boolean; closeToTray: boolean; autoplay: boolean; autoSkip: boolean;
  equalizer: EqualizerSettings;
};
export type PersistedState = {
  version: 1; tracks: Track[]; playlists: Playlist[]; history: string[];
  queue: string[]; currentTrackId: string | null; position: number; settings: AppSettings;
};
export type Capability = { id: string; label: string; status: 'unknown' | 'verified' | 'unsupported'; detail: string; checkedAt?: number };
export type VkStatus = {
  state: 'not-configured' | 'disconnected' | 'connecting' | 'waiting-login' | 'connected' | 'error';
  message: string; user?: { id: number; name: string; avatar?: string };
  capabilities: Capability[]; lastSyncAt?: number; requiresReauth?: boolean;
  mode?: 'web' | 'api'; syncProgress?: VkSyncProgress;
};
export type VkSyncProgress = { phase: string; tracks: number; playlists: number; completedPlaylists: number };
export type PlaybackNetwork = 'idle' | 'loading' | 'ready' | 'stalled' | 'offline' | 'recovering' | 'error';
export type VkWebPlayback = { id: string | null; requestedId?: string | null; playing: boolean; buffering: boolean; recovering?: boolean; seeking?: boolean; advertising?: boolean; position: number; duration: number; buffered?: Array<[number, number]>; bufferedAhead?: number; network?: PlaybackNetwork; error?: string | null; ended: boolean; runId?: string; equalizerEnabled?: boolean; equalizerError?: string | null };
export type VkWebCommand = { operation: 'play' | 'pause' | 'resume' | 'seek' | 'volume' | 'stop' | 'equalizer'; id?: string; position?: number; volume?: number; equalizer?: EqualizerSettings };
export type VkSnapshot = {
  status: VkStatus; tracks: Track[]; playlists: Playlist[]; complete: boolean;
  syncedAt?: number | null; error?: string; mutationConfirmed?: boolean;
  mode?: 'web' | 'api'; progress?: VkSyncProgress;
  clearRemote?: boolean;
  unchanged?: boolean;
  createdPlaylistId?: string;
  addedTrack?: { sourceId: string; ownedId: string };
};
export type DesktopCommand = 'play-pause' | 'next' | 'previous' | 'import';
export type MusicImportItem = { name: string; status: 'uploaded' | 'local' | 'failed' | 'uncertain' | 'skipped'; message: string; trackId?: string; track?: Track };
export type UploadBatchResult = { items: MusicImportItem[]; cancelled: boolean; accountId?: number };
export type ImportProgress = { phase: string; message: string; current: number; total: number };
export type AppRelease = { currentVersion: string; latestVersion: string | null; available: boolean; notes: string; releaseUrl: string | null; downloadUrl: string | null };
export interface DesktopAPI {
  getState(): Promise<PersistedState | null>;
  saveState(state: PersistedState): Promise<void>;
  importFiles(): Promise<Track[]>;
  uploadFilesToVk?(): Promise<UploadBatchResult>;
  uploadLocalTrackToVk?(id: string): Promise<UploadBatchResult>;
  importFromUrl?(url: string, destination: 'vk' | 'local', proxy?: string): Promise<UploadBatchResult>;
  onImportProgress?(callback: (progress: ImportProgress) => void): () => void;
  onAppNotice?(callback: (message: string) => void): () => void;
  removeTrack(id: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  openVkMusic(): Promise<void>;
  getVkStatus(): Promise<VkStatus>;
  connectVk(): Promise<VkStatus>;
  disconnectVk(): Promise<VkStatus>;
  refreshVk(): Promise<VkSnapshot>;
  addVkTrack(track: Track): Promise<VkSnapshot>;
  deleteVkTrack(id: string): Promise<VkSnapshot>;
  vkPlaylistChange(input: { operation: 'create' | 'rename' | 'delete' | 'add-track' | 'remove-track' | 'edit'; playlistId?: string; title?: string; description?: string; trackIds?: string[]; track?: Track }): Promise<VkSnapshot>;
  searchVk(query: string): Promise<Track[]>;
  artistMusic?(input: ArtistMusicRequest): Promise<ArtistMusicResult>;
  resolveVkTrack(id: string): Promise<Track>;
  vkWebControl?(command: VkWebCommand): Promise<{ accepted: boolean; pending?: boolean; error?: string; equalizerError?: string | null }>;
  onVkUpdate?(callback: (snapshot: VkSnapshot) => void): () => void;
  onVkPlayback?(callback: (status: VkWebPlayback) => void): () => void;
  getVersion(): Promise<string>;
  checkAppRelease?(): Promise<AppRelease>;
  exportDiagnostics(): Promise<string | null>;
  onCommand(callback: (command: DesktopCommand) => void): () => void;
  onCloseRequest?(callback: () => Promise<void>): () => void;
}
declare global { interface Window { desktop?: DesktopAPI } }
