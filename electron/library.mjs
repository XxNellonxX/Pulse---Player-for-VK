import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const audioExtensions = ['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wav', 'weba', 'webm'];
export const mediaType = file => ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', weba: 'audio/webm', webm: 'audio/webm' })[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';

async function contentFingerprint(file, size) {
  const hash = createHash('sha256');
  hash.update(String(size));
  const ranges = size <= 256 * 1024 * 1024 ? [[0, size - 1]] : [[0, Math.min(size, 1024 * 1024) - 1], [Math.max(0, size - 1024 * 1024), size - 1]];
  for (const [start, end] of ranges) {
    for await (const chunk of createReadStream(file, { start, end })) hash.update(chunk);
  }
  return hash.digest('hex').slice(0, 24);
}

export async function inspectAudio(file) {
  const absolute = await realpath(file);
  if (!audioExtensions.includes(path.extname(absolute).slice(1).toLowerCase())) throw new Error('Формат файла не поддерживается');
  const info = await stat(absolute);
  if (!info.isFile() || info.size === 0 || info.size > 4 * 1024 ** 3) throw new Error('Файл пуст или превышает 4 ГБ');
  const { parseFile } = await import('music-metadata');
  const metadata = await parseFile(absolute, { duration: true, skipPostHeaders: true });
  if (!metadata.format.codec && !metadata.format.container) throw new Error('Не удалось прочитать аудиофайл');
  const id = `local-${await contentFingerprint(absolute, info.size)}`;
  const picture = metadata.common.picture?.find(p => p.data.length < 1024 * 1024 && ['image/jpeg', 'image/png', 'image/webp'].includes(p.format));
  return {
    path: absolute,
    track: {
      id, title: metadata.common.title || path.basename(absolute, path.extname(absolute)),
      artist: metadata.common.artist || 'Неизвестный исполнитель', album: metadata.common.album || '',
      duration: Number.isFinite(metadata.format.duration) ? metadata.format.duration : 0,
      artwork: picture ? `data:${picture.format};base64,${Buffer.from(picture.data).toString('base64')}` : undefined,
      url: `pulse-media://track/${id}`, source: 'local', addedAt: Date.now(), available: true,
    },
  };
}

export function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end, partial: true };
}
