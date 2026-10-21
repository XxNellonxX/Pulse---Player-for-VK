import { app, BrowserWindow, dialog, ipcMain, protocol, shell, session, Menu, Tray, nativeImage, globalShortcut, systemPreferences, safeStorage } from 'electron';
import { createReadStream } from 'node:fs';
import { readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AtomicStore, validateState } from './storage.mjs';
import { inspectAudio, parseRange, mediaType } from './library.mjs';
import VkAuth from './vk-auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
if (isDev && process.env.PULSE_TEST_USER_DATA) app.setPath('userData', path.resolve(process.env.PULSE_TEST_USER_DATA));
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
protocol.registerSchemesAsPrivileged([{ scheme: 'pulse-media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const defaultState = { version: 1, tracks: [], playlists: [], history: [], queue: [], currentTrackId: null, position: 0, settings: { theme: 'dark', style: 'minimal', accent: '#b6f36a', density: 'comfortable', textScale: 1, reducedMotion: false, volume: .7, repeat: 'off', shuffle: false, closeToTray: false, autoplay: false, autoSkip: true } };
let win, tray, store, vkWindow, state = defaultState, vkStatus;
const mediaPaths = new Map();
let vkConfig = { clientId: process.env.VK_CLIENT_ID || '', redirectUri: process.env.VK_REDIRECT_URI || 'http://127.0.0.1:49281/callback', scopes: 'vkid.personal_info', apiVersion: '5.199' };
let vkAuth, vkAuthInitError = '';
const emptyCapabilities = [
  ['auth', 'Авторизация VK', 'unknown', 'Требуется зарегистрированный VK ID public client и redirect URI.'],
  ['search', 'Поиск музыки VK', 'unknown', 'Доступ к аудио API не подтверждён для этого приложения.'],
  ['stream', 'Воспроизведение VK', 'unknown', 'Поток VK будет включён только после реального теста доступа.'],
  ['library', 'Моя музыка', 'unknown', 'Синхронизация библиотеки требует разрешённого audio API.'],
  ['playlists', 'Плейлисты VK', 'unknown', 'CRUD плейлистов требует проверки на тестовом аккаунте.'],
  ['upload', 'Загрузка в VK', 'unknown', 'Официальный метод загрузки аудио не подтверждён.'],
  ['recommendations', 'Автоматические рекомендации', 'verified', 'Приложение не добавляет рекомендации в очередь.'],
];
vkStatus = createVkStatus('not-configured');
function createVkStatus(stateName, message = '') { return { state: stateName, message: message || (stateName === 'not-configured' ? 'Настройка VK ID требуется один раз перед первым входом.' : ''), capabilities: emptyCapabilities.map(([id, label, status, detail]) => ({ id, label, status, detail })) }; }
function statusFromAuth(status) {
  const stateName = status?.state === 'expired' ? 'error' : status?.state === 'not-configured' ? 'not-configured' : status?.state || 'disconnected';
  const next = createVkStatus(stateName, status?.message || '');
  if (status?.requiresReauth === true) next.requiresReauth = true;
  next.capabilities = next.capabilities.map(capability => capability.id === 'auth' ? { ...capability, status: stateName === 'connected' ? 'verified' : stateName === 'not-configured' ? 'unknown' : capability.status, detail: stateName === 'connected' ? 'VK ID подтверждён. Музыкальные права проверяются отдельно.' : capability.detail } : capability);
  if (status?.userId) next.user = { id: Number(status.userId), name: 'VK ID' };
  return next;
}
function setMusicCapability(id, status, detail) {
  vkStatus = { ...vkStatus, capabilities: vkStatus.capabilities.map(item => item.id === id ? { ...item, status, detail, checkedAt: Date.now() } : item) };
}
function mapVkAudio(item) {
  if (!item || typeof item !== 'object' || !Number.isSafeInteger(Number(item.id)) || !Number.isSafeInteger(Number(item.owner_id))) return null;
  const ownerId = Number(item.owner_id); const audioId = Number(item.id); const url = typeof item.url === 'string' && /^https?:/i.test(item.url) ? item.url : '';
  const artwork = item.album && typeof item.album.thumb_photo === 'string' ? item.album.thumb_photo : (item.album && typeof item.album.thumb?.photo_300 === 'string' ? item.album.thumb.photo_300 : undefined);
  return { id: `vk-${ownerId}-${audioId}`, title: typeof item.title === 'string' ? item.title : 'Без названия', artist: typeof item.artist === 'string' ? item.artist : 'Неизвестный исполнитель', album: typeof item.album?.title === 'string' ? item.album.title : '', duration: Number.isFinite(Number(item.duration)) ? Number(item.duration) : 0, artwork, url: url || `vk-audio://${ownerId}/${audioId}`, source: 'vk', addedAt: Date.now(), available: Boolean(url), remote: { ownerId, audioId } };
}
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
function safeFileUrl(id) { return mediaPaths.get(id); }

async function createWindow() {
  win = new BrowserWindow({ width: 1440, height: 900, minWidth: 960, minHeight: 620, backgroundColor: '#0c0d0f', title: 'VK Player', show: false, autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' } });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (isDev ? !url.startsWith('http://127.0.0.1:5173/') : !url.startsWith('file:')) event.preventDefault();
  });
  win.on('close', event => { if (state.settings.closeToTray && !app.isQuitting) { event.preventDefault(); win.hide(); } });
  if (isDev) await win.loadURL('http://127.0.0.1:5173'); else await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  const command = key => send('player:command', key);
  globalShortcut.register('MediaPlayPause', () => command('play-pause'));
  globalShortcut.register('MediaNextTrack', () => command('next'));
  globalShortcut.register('MediaPreviousTrack', () => command('previous'));
}

async function openFileDialog() {
  const result = await dialog.showOpenDialog(win, { title: 'Добавить аудиофайлы', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Аудио', extensions: ['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wav', 'weba', 'webm'] }] });
  if (result.canceled) return [];
  const added = []; const errors = [];
  for (const file of result.filePaths) { try { const { track, path: absolute } = await inspectAudio(file); mediaPaths.set(track.id, absolute); added.push(track); } catch (error) { errors.push(`${path.basename(file)}: ${error.message}`); } }
  if (errors.length) send('app:notice', { type: 'warning', message: `Не удалось добавить ${errors.length} файл(а): ${errors.slice(0, 3).join('; ')}` });
  return added;
}

function publicUrlFor(id) { return `pulse-media://track/${encodeURIComponent(id)}`; }
function setupIpc() {
  const handle = (channel, callback) => ipcMain.handle(channel, (event, ...args) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Недоверенный источник запроса');
    return callback(event, ...args);
  });
  handle('state:get', () => state);
  handle('state:save', async (_event, next) => { state = validateState(next, Array.isArray(next?.tracks) ? next.tracks : state.tracks); await store.write({ schema: 1, files: [...mediaPaths.entries()], state }); return state; });
  handle('library:import', async () => { const tracks = await openFileDialog(); for (const track of tracks) { mediaPaths.set(track.id, mediaPaths.get(track.id)); } state = validateState({ ...state, tracks: [...state.tracks.filter(t => !tracks.some(n => n.id === t.id)), ...tracks] }, state.tracks.concat(tracks)); await store.write({ schema: 1, files: [...mediaPaths.entries()], state }); return tracks; });
  handle('library:remove', async (_event, id) => { mediaPaths.delete(id); state = validateState({ ...state, tracks: state.tracks.filter(track => track.id !== id), queue: state.queue.filter(trackId => trackId !== id) }, state.tracks.filter(track => track.id !== id)); await store.write({ schema: 1, files: [...mediaPaths.entries()], state }); });
  handle('shell:open', (_event, url) => /^https:\/\/(id\.vk\.ru|vk\.com)(\/|$)/i.test(url) ? shell.openExternal(url) : Promise.reject(new Error('Разрешены только ссылки VK')));
  handle('vk:web', async () => {
    if (vkWindow && !vkWindow.isDestroyed()) { vkWindow.show(); vkWindow.focus(); return; }
    vkWindow = new BrowserWindow({ width: 1280, height: 850, title: 'VK Музыка · официальный сайт', autoHideMenuBar: true, webPreferences: { partition: 'persist:vk-official-web', sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const allowedVkHost = host => ['vk.com', 'vk.ru', 'id.vk.ru'].some(root => host === root || host.endsWith(`.${root}`));
    vkWindow.webContents.setWindowOpenHandler(({ url }) => { try { const target = new URL(url); if (target.protocol === 'https:' && allowedVkHost(target.hostname)) return { action: 'allow' }; } catch {} return { action: 'deny' }; });
    vkWindow.webContents.on('will-navigate', (event, url) => { try { const target = new URL(url); if (target.protocol !== 'https:' || !allowedVkHost(target.hostname)) event.preventDefault(); } catch { event.preventDefault(); } });
    vkWindow.on('closed', () => { vkWindow = null; });
    await vkWindow.loadURL('https://vk.com/audio');
  });
  handle('vk:status', async () => { if (!vkAuth) return createVkStatus('error', vkAuthInitError || 'VK ID не удалось инициализировать.'); vkStatus = statusFromAuth(await vkAuth.getStatus()); return vkStatus; });
  handle('vk:connect', async () => { if (!vkAuth) return createVkStatus('error', vkAuthInitError || 'VK ID не удалось инициализировать.'); vkStatus = createVkStatus('connecting', 'Открываем безопасный вход VK ID…'); send('vk:status', vkStatus); try { vkStatus = statusFromAuth(await vkAuth.connect()); } catch (error) { vkStatus = createVkStatus(error.code === 'not_configured' ? 'not-configured' : 'error', error.message || 'Не удалось подключить VK ID.'); } return vkStatus; });
  handle('vk:disconnect', async () => { try { if (vkAuth) vkStatus = statusFromAuth(await vkAuth.disconnect()); else vkStatus = createVkStatus('disconnected', 'Локальная сессия VK ID удалена.'); } catch { vkStatus = createVkStatus('disconnected', 'Локальная сессия VK ID удалена.'); } return vkStatus; });
  handle('vk:refresh', async () => {
    if (!vkAuth) return { status: createVkStatus('error', vkAuthInitError || 'VK ID не удалось инициализировать.'), tracks: [] };
    try {
      vkStatus = statusFromAuth(await vkAuth.refreshIfNeeded());
      const response = await vkAuth.apiRequest('audio.get', { count: 200, extended: 1 });
      const tracks = Array.isArray(response?.items) ? response.items.map(mapVkAudio).filter(Boolean) : [];
      setMusicCapability('library', 'verified', 'VK вернул библиотеку аудио и она прочитана обратно.');
      setMusicCapability('stream', tracks.some(track => track.available) ? 'verified' : 'unknown', tracks.some(track => track.available) ? 'VK вернул поток для части треков.' : 'VK вернул метаданные без доступного потока.');
      vkStatus = { ...vkStatus, lastSyncAt: Date.now(), message: `Библиотека VK проверена: ${tracks.length} треков.` };
      return { status: vkStatus, tracks };
    } catch (error) {
      vkStatus = statusFromAuth(await vkAuth.getStatus().catch(() => ({ state: 'error', message: 'Синхронизация VK не завершена.' })));
      setMusicCapability('library', 'unknown', error?.message || 'VK не подтвердил доступ к аудио API.');
      return { status: { ...vkStatus, message: error?.message || 'VK не подтвердил доступ к аудио API.' }, tracks: [] };
    }
  });
  handle('vk:search', async (_event, query) => {
    if (!vkAuth || typeof query !== 'string' || !query.trim()) return [];
    try {
      const response = await vkAuth.apiRequest('audio.search', { q: query.trim().slice(0, 200), count: 50, extended: 1 });
      setMusicCapability('search', 'verified', 'Поиск VK подтвердил доступ к аудио API.');
      return Array.isArray(response?.items) ? response.items.map(mapVkAudio).filter(Boolean) : [];
    } catch (error) { setMusicCapability('search', 'unknown', error?.message || 'VK не подтвердил поиск аудио.'); return []; }
  });
  handle('vk:resolve', async (_event, id) => {
    const track = state.tracks.find(item => item.id === id); if (!track) throw new Error('Трек не найден');
    if (track.source !== 'vk' || !track.remote || !vkAuth) return track;
    try { const response = await vkAuth.apiRequest('audio.getById', { audios: `${track.remote.ownerId}_${track.remote.audioId}` }); const resolved = Array.isArray(response) ? mapVkAudio(response[0]) : null; return resolved || track; } catch { return track; }
  });
  handle('app:version', () => app.getVersion());
  handle('app:diagnostics', async () => { const out = path.join(app.getPath('documents'), 'VK Player diagnostics.json'); await writeFileSafe(out, JSON.stringify({ app: app.getVersion(), platform: process.platform, arch: process.arch, vk: { state: vkStatus.state, capabilities: vkStatus.capabilities }, tracks: state.tracks.length }, null, 2)); return out; });
}
async function writeFileSafe(file, data) { await mkdir(path.dirname(file), { recursive: true }); await (await import('node:fs/promises')).writeFile(file, data, 'utf8'); }

app.whenReady().then(async () => {
  protocol.handle('pulse-media', async request => {
    const id = decodeURIComponent(new URL(request.url).pathname.split('/').pop() || ''); const file = safeFileUrl(id); if (!file) return new Response('Not found', { status: 404 });
    try { const info = await (await import('node:fs/promises')).stat(file); const range = parseRange(request.headers.get('range'), info.size); if (!range) return new Response('Range Not Satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } }); const headers = { 'Content-Type': mediaType(file), 'Accept-Ranges': 'bytes', 'Content-Length': String(range.end - range.start + 1), 'Cache-Control': 'no-store' }; if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`; return new Response(createReadStream(file, { start: range.start, end: range.end }), { status: range.partial ? 206 : 200, headers }); } catch { return new Response('Not found', { status: 404 }); }
  });
  try {
    const configured = JSON.parse(await readFile(new URL('./vk-config.json', import.meta.url), 'utf8'));
    vkConfig = { ...vkConfig, ...configured, clientId: process.env.VK_CLIENT_ID || configured.clientId || vkConfig.clientId, redirectUri: process.env.VK_REDIRECT_URI || configured.redirectUri || vkConfig.redirectUri };
  } catch { /* an empty config is a visible setup blocker */ }
  store = new AtomicStore(app.getPath('userData'));
  const persisted = await store.read();
  if (persisted.state) { try { state = validateState(persisted.state, persisted.state.tracks || []); } catch { state = defaultState; } }
  for (const entry of Array.isArray(persisted.files) ? persisted.files : []) {
    if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') mediaPaths.set(entry[0], entry[1]);
  }
  try { vkAuth = new VkAuth({ ...vkConfig, userData: app.getPath('userData'), openExternal: url => shell.openExternal(url), safeStorage }); }
  catch (error) { vkAuth = null; vkAuthInitError = error?.message || 'Некорректная конфигурация VK ID.'; }
  setupIpc(); await createWindow();
  if (process.platform === 'win32') {
    tray = new Tray(nativeImage.createEmpty());
    tray.setToolTip('VK Player');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Показать VK Player', click: () => win?.show() },
      { type: 'separator' },
      { label: 'Выйти', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', () => win?.isVisible() ? win.hide() : win?.show());
  }
  app.on('activate', () => win?.show());
});
app.on('before-quit', () => { app.isQuitting = true; globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
