/** Metadata only. Provider audio URLs, OAuth tokens and preview clips never enter this contract. */
export type ImportService = 'spotify' | 'yandex';
export type ServicePlaylistEntry = {
  sourceId: string; title: string; artists: string[]; album: string; duration: number;
  position: number; isrc?: string; explicit?: boolean; artwork?: string; addedAt?: number;
};
export type ServicePlaylistSource = {
  service: ImportService; sourceId: string; sourceUrl: string; title: string;
  description?: string; artwork?: string; total: number | null; complete: boolean;
  warnings: string[]; entries: ServicePlaylistEntry[];
};
export type ServiceAccountStatus = { configured: boolean; connected: boolean; message: string; userName?: string };
export type ServiceImportStatus = { spotify: ServiceAccountStatus; yandex: ServiceAccountStatus };
export type ServicePlaylistDescriptor = {
  service: ImportService; sourceId: string; sourceUrl: string; title: string;
  total: number | null; artwork?: string;
};

const MAX_ENTRIES = 20_000;
const text = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 2000) : '';
const safeId = (value: unknown, fallback: string) => text(value).slice(0, 256) || fallback;
const milliseconds = (value: unknown) => {
  const numeric = typeof value === 'string' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isFinite(numeric) && numeric > 0 ? numeric / 1000 : 0;
};

/** RFC 4180 quoting, embedded newlines, comma/semicolon/tab exports, and a strict size/row cap. */
export function parseImportCsv(input: string): string[][] {
  if (input.length > 8 * 1024 * 1024) throw new Error('Файл метаданных больше 8 МБ. Разделите экспорт на несколько частей.');
  const source = input.replace(/^\uFEFF/u, '');
  const firstLine = source.split(/\r?\n/u, 1)[0] || '';
  const delimiter = ['\t', ';', ','].map(value => ({ value, count: countOutsideQuotes(firstLine, value) }))
    .sort((a, b) => b.count - a.count)[0].value;
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false; let afterQuote = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') { cell += '"'; index++; }
      else if (!quoted && cell.length > 0) throw new Error('Некорректные кавычки в CSV. Сохраните файл как CSV UTF-8.');
      else { afterQuote = quoted; quoted = !quoted; }
    } else if (!quoted && (character === delimiter || character === '\r' || character === '\n')) {
      row.push(cell); cell = ''; afterQuote = false;
      if (character !== delimiter) {
        if (row.some(value => value.trim())) rows.push(row);
        row = [];
        if (character === '\r' && source[index + 1] === '\n') index++;
      }
    } else {
      if (afterQuote) throw new Error('После закрывающей кавычки в CSV должен быть разделитель или новая строка.');
      cell += character;
    }
    if (rows.length > MAX_ENTRIES + 1 || row.length > 100 || cell.length > 64 * 1024) throw new Error('Слишком много строк или слишком длинное поле в файле импорта.');
  }
  if (quoted) throw new Error('CSV заканчивается внутри поля в кавычках. Экспортируйте файл заново.');
  row.push(cell); if (row.some(value => value.trim())) rows.push(row);
  if (rows.length > MAX_ENTRIES + 1) throw new Error('За один раз можно импортировать до 20 000 треков.');
  return rows;
}

function countOutsideQuotes(value: string, target: string): number {
  let quoted = false; let count = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '"') { if (quoted && value[index + 1] === '"') index++; else quoted = !quoted; }
    else if (!quoted && value[index] === target) count++;
  }
  return count;
}

function artistList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => typeof item === 'object' && item ? text((item as { name?: unknown }).name) : text(item)).filter(Boolean).slice(0, 30);
  // Commas are part of many real stage names. Export formats use semicolons for multiple artists.
  return text(value).split(/\s*;\s*/u).filter(Boolean).slice(0, 30);
}

export function parseServiceExport(input: string, service: ImportService, filename: string): ServicePlaylistSource {
  if (input.length > 8 * 1024 * 1024) throw new Error('Файл метаданных больше 8 МБ. Разделите экспорт на несколько частей.');
  const entries: ServicePlaylistEntry[] = []; const warnings: string[] = [];
  let total = 0; let title = filename.replace(/\.(csv|tsv|json)$/iu, '') || 'Импортированная коллекция';
  const append = (raw: Record<string, unknown>, position: number) => {
    const name = text(raw.title ?? raw.name); const artists = artistList(raw.artists ?? raw.artist);
    if (!name || !artists.length) { warnings.push(`Строка ${position + 1}: не хватает названия или исполнителя.`); return; }
    const isrc = text(raw.isrc).replace(/[\s-]/gu, '').toUpperCase();
    const explicit = raw.explicit === true || /^(true|1|yes)$/iu.test(text(raw.explicit)) ? true
      : raw.explicit === false || /^(false|0|no)$/iu.test(text(raw.explicit)) ? false : undefined;
    const duration = raw.durationMs !== undefined ? milliseconds(raw.durationMs) : Number(raw.duration) || 0;
    entries.push({ sourceId: safeId(raw.id, `row-${position}`), title: name, artists, album: text(raw.album),
      duration: duration > 0 && Number.isFinite(duration) ? duration : 0, position,
      ...(isrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/u.test(isrc) ? { isrc } : {}),
      ...(explicit !== undefined ? { explicit } : {}) });
  };
  if (/^\s*[\[{]/u.test(input)) {
    let parsed: unknown;
    try { parsed = JSON.parse(input); } catch { throw new Error('Не удалось прочитать JSON. Нужен массив tracks с полями title и artists.'); }
    const object = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(object?.tracks) ? object.tracks : undefined;
    if (!rows) throw new Error('В JSON не найден список tracks. Нужны название и исполнитель каждого трека.');
    if (rows.length > MAX_ENTRIES) throw new Error('За один раз можно импортировать до 20 000 треков.');
    title = text(object?.title) || title; total = rows.length;
    rows.forEach((value, index) => { if (value && typeof value === 'object') append(value as Record<string, unknown>, index); else warnings.push(`Строка ${index + 1}: неверная запись.`); });
  } else {
    const rows = parseImportCsv(input); const headers = rows.shift()?.map(value => value.trim().toLowerCase().replace(/[ _-]/gu, '')) || [];
    const find = (...names: string[]) => headers.findIndex(header => names.includes(header));
    const nameIndex = find('trackname', 'title', 'name', 'название', 'трек');
    const artistIndex = find('artistname(s)', 'artistnames', 'artistname', 'artists', 'artist', 'исполнитель', 'исполнители');
    if (nameIndex < 0 || artistIndex < 0) throw new Error('В CSV нужны колонки Track Name и Artist Name(s), либо title и artists. Порядок колонок любой.');
    const albumIndex = find('albumname', 'album', 'альбом'); const durationIndex = find('duration(ms)', 'durationms', 'duration_ms');
    const secondsIndex = find('duration', 'durationseconds'); const idIndex = find('trackuri', 'trackid', 'id');
    const isrcIndex = find('isrc'); const explicitIndex = find('explicit'); total = rows.length;
    rows.forEach((row, index) => append({ title: row[nameIndex], artists: row[artistIndex], album: row[albumIndex], id: row[idIndex],
      isrc: row[isrcIndex], explicit: row[explicitIndex], ...(durationIndex >= 0 ? { durationMs: row[durationIndex] } : { duration: row[secondsIndex] }) }, index));
  }
  if (!entries.length) throw new Error('В экспорте нет треков с названием и исполнителем.');
  return { service, sourceId: `file:${filename.slice(0, 220)}`, sourceUrl: '', title, total, complete: entries.length === total,
    warnings: warnings.slice(0, 30).concat(warnings.length > 30 ? [`Ещё ${warnings.length - 30} строк требуют проверки.`] : []), entries };
}
