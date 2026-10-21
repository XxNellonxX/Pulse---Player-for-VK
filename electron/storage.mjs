import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import path from 'node:path';

export class AtomicStore {
  constructor(directory, name = 'library.json') {
    this.directory = directory;
    this.file = path.join(directory, name);
    this.pending = Promise.resolve();
    this.recovered = false;
  }
  async read() {
    for (const file of [this.file, `${this.file}.bak`]) {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.files)) throw new Error('Invalid storage');
        this.recovered = file.endsWith('.bak');
        return parsed;
      } catch (error) {
        if (error.code !== 'ENOENT') this.recovered = true;
      }
    }
    return { schema: 1, files: [], state: null };
  }
  write(value) {
    const serialized = JSON.stringify(value);
    this.pending = this.pending.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true });
      const temp = `${this.file}.tmp`;
      await writeFile(temp, serialized, { encoding: 'utf8', flush: true });
      if (!this.recovered) {
        try { await copyFile(this.file, `${this.file}.bak`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await rename(temp, this.file);
      this.recovered = false;
    });
    return this.pending;
  }
}

export function validateState(input, allowedTracks) {
  if (!input || input.version !== 1 || !Array.isArray(input.tracks) || !Array.isArray(input.queue)) throw new Error('Некорректные данные библиотеки');
  if (input.tracks.length > 100000 || input.queue.length > 100000) throw new Error('Слишком большая библиотека');
  const safeTrack = (track, index) => {
    if (!track || typeof track !== 'object') return null;
    const string = (value, fallback = '') => typeof value === 'string' ? value.slice(0, 500) : fallback;
    const id = string(track.id, `track-${index}`);
    const url = typeof track.url === 'string' && /^(pulse-media|vk-audio|https?|data):/i.test(track.url) ? track.url : '';
    if (!url) return null;
    const numberValue = (value, min, max, fallback) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    return { id, title: string(track.title, 'Без названия'), artist: string(track.artist, 'Неизвестный исполнитель'), album: string(track.album), duration: numberValue(Number(track.duration), 0, 864000, 0), artwork: typeof track.artwork === 'string' && /^(data:image|https?:)/i.test(track.artwork) ? track.artwork.slice(0, 2_000_000) : undefined, url, source: track.source === 'vk' ? 'vk' : 'local', addedAt: numberValue(Number(track.addedAt), 0, Date.now(), Date.now()), available: track.available !== false, remote: track.remote && Number.isSafeInteger(track.remote.ownerId) && Number.isSafeInteger(track.remote.audioId) ? { ownerId: track.remote.ownerId, audioId: track.remote.audioId } : undefined };
  };
  const tracks = []; const seenTracks = new Set();
  for (const [index, track] of (Array.isArray(allowedTracks) ? allowedTracks : []).entries()) { const safe = safeTrack(track, index); if (safe && !seenTracks.has(safe.id)) { seenTracks.add(safe.id); tracks.push(safe); } }
  const valid = new Set(tracks.map(track => track.id));
  const ids = value => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && valid.has(id)))].slice(0, 100000) : [];
  const settings = input.settings ?? {};
  const enumValue = (value, values, fallback) => values.includes(value) ? value : fallback;
  const numberValue = (value, min, max, fallback) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const string = (value, fallback = '') => typeof value === 'string' ? value.slice(0, 500) : fallback;
  return {
    version: 1, tracks,
    playlists: Array.isArray(input.playlists) ? input.playlists.slice(0, 5000).filter(p => p && typeof p.id === 'string').map(p => ({
      id: string(p.id), title: string(p.title, 'Плейлист'), trackIds: ids(p.trackIds), createdAt: numberValue(p.createdAt, 0, Date.now(), Date.now()),
    })) : [],
    history: ids(input.history).slice(0, 1000), queue: ids(input.queue),
    currentTrackId: valid.has(input.currentTrackId) ? input.currentTrackId : null,
    position: numberValue(input.position, 0, 864000, 0),
    settings: {
      theme: enumValue(settings.theme, ['dark', 'light', 'system', 'high-contrast'], 'dark'),
      style: enumValue(settings.style, ['minimal', 'compact', 'album', 'soft'], 'minimal'),
      accent: /^#[a-f\d]{6}$/i.test(settings.accent) ? settings.accent : '#b6f36a',
      density: enumValue(settings.density, ['comfortable', 'compact'], 'comfortable'),
      textScale: numberValue(settings.textScale, .85, 1.3, 1),
      reducedMotion: settings.reducedMotion === true, volume: numberValue(settings.volume, 0, 1, .7),
      repeat: enumValue(settings.repeat, ['off', 'all', 'one'], 'off'), shuffle: settings.shuffle === true,
      closeToTray: settings.closeToTray === true, autoplay: settings.autoplay === true, autoSkip: settings.autoSkip === true,
    },
  };
}
