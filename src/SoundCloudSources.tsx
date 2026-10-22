import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Check, Cloud, ExternalLink, Link2, LoaderCircle, Search, ShieldCheck, Unlink } from 'lucide-react'
import type { AppSettings, Track } from './shared/contracts'
import { rankSoundCloudCandidates, recordingCensorship, type RankedSourceCandidate, type SoundCloudCandidate, type SoundCloudBinding } from './shared/sourceMatching'
import './SoundCloudSources.css'

type SoundCloudStatus = { configured: boolean; proxy: boolean; message: string };
type SettingsProps = { settings?: Pick<AppSettings, 'preferSoundCloud' | 'preferExplicit'>; onChange?: (patch: Partial<AppSettings>) => void };
const failure = (error: unknown) => {
  // Tauri rejects invoke promises with the native command's public string.
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return message.trim().slice(0, 600) || 'Не удалось выполнить запрос. Попробуйте ещё раз.';
};
const time = (seconds: number) => Number.isFinite(seconds) && seconds > 0 ? `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}` : 'Длительность неизвестна';
const openLink = (value?: string) => {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && ['soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com', 'developers.soundcloud.com'].includes(url.hostname) && !url.username && !url.password) void window.desktop?.openExternal(url.href)?.catch(() => {});
  } catch { /* Optional provider link is not a source identity. */ }
};

function SoundCloudApiGuide() {
  return <aside className="sc-api-guide"><strong>Если у вас обычный аккаунт SoundCloud</strong><p>Вход в аккаунт сам по себе не выдаёт Client ID и Client Secret. Проверьте, доступно ли создание приложения в кабинете SoundCloud.</p><button type="button" className="sc-text-button" onClick={() => openLink('https://soundcloud.com/you/apps')}>Открыть кабинет приложений <ExternalLink size={12} /></button><p>Если создание приложения недоступно, поиск и привязка через официальный API пока не заработают. Доступ одобряет SoundCloud; платная подписка не гарантирует его получение.</p></aside>;
}

export function SoundCloudSettings({ settings, onChange }: SettingsProps) {
  const [status, setStatus] = useState<SoundCloudStatus | null>(null);
  const [clientId, setClientId] = useState(''), [clientSecret, setClientSecret] = useState(''), [proxy, setProxy] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), [editProxy, setEditProxy] = useState(false);
  const alive = useRef(true), generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    const run = ++generation.current;
    if (window.desktop?.soundCloudStatus) void window.desktop.soundCloudStatus().then(value => { if (alive.current && run === generation.current) setStatus(value); }, cause => { if (alive.current && run === generation.current) setError(failure(cause)); });
    else setError('Подключение SoundCloud доступно в настольном Pulse.');
    return () => { alive.current = false; generation.current++; };
  }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !window.desktop?.configureSoundCloud) return;
    if (Boolean(clientId.trim()) !== Boolean(clientSecret.trim())) { setError('Введите Client ID и Client Secret вместе.'); return; }
    if (!status?.configured && (!clientId.trim() || !clientSecret.trim())) { setError('Для первого подключения нужны Client ID и Client Secret приложения SoundCloud.'); return; }
    const run = ++generation.current;
    setBusy(true); setError(''); setSaved(false);
    try {
      await window.desktop.configureSoundCloud({ clientId: clientId.trim(), clientSecret: clientSecret.trim(), ...(editProxy || !status?.configured ? { proxy: proxy.trim() } : {}) });
      if (!alive.current || run !== generation.current) return;
      // Secrets are never read back into the renderer or persisted in browser storage.
      setClientId(''); setClientSecret(''); setProxy(''); setEditProxy(false);
      const next = await window.desktop.soundCloudStatus?.();
      if (alive.current && run === generation.current) { if (next) setStatus(next); setSaved(true); }
    } catch (cause) { if (alive.current && run === generation.current) setError(failure(cause)); }
    finally { if (alive.current && run === generation.current) setBusy(false); }
  };
  return <section className="settings-section sc-settings" aria-label="SoundCloud">
    <div className="settings-section-heading"><h2>SoundCloud</h2><p>Другой источник звука для вашей библиотеки.</p></div>
    <div className={`sc-connection ${status?.configured ? 'is-ready' : ''}`}><span className="sc-service-icon"><Cloud size={23} /></span><div><strong>{status?.configured ? 'Подключение настроено' : 'Подключите приложение'}</strong><p>{status?.message || 'Pulse использует официальный API SoundCloud.'}</p><span className="sc-route">{status?.proxy ? 'SoundCloud через отдельный прокси' : 'Прямое соединение'}</span></div>{status?.configured && <ShieldCheck size={18} />}</div>
    {status?.configured === false && <SoundCloudApiGuide />}
    {settings && onChange && <div className="sc-preferences"><label className="sc-preference"><span><strong>Предпочитать SoundCloud</strong><small>Для треков без карточки артиста VK и при ошибке источника. При неоднозначном совпадении можно выбрать версию.</small></span><input type="checkbox" checked={settings.preferSoundCloud} onChange={event => onChange({ preferSoundCloud: event.target.checked })} /></label><label className="sc-preference"><span><strong>Предпочитать версии Explicit</strong><small>Среди подходящих записей выше версии с пометкой Explicit. Замена известной Clean-версии подтверждается вручную. Отсутствие пометки не означает цензуру.</small></span><input type="checkbox" checked={settings.preferExplicit} onChange={event => onChange({ preferExplicit: event.target.checked })} /></label></div>}
    <form className="sc-config-form" onSubmit={event => void save(event)}>
      <div className="sc-form-intro"><strong>{status?.configured ? 'Обновить подключение' : 'Ключи приложения SoundCloud'}</strong><p>{status?.configured ? 'Чтобы сохранить прежние ключи, оставьте оба поля пустыми.' : 'Client ID и Client Secret выдаёт SoundCloud для зарегистрированного приложения. Пароль от аккаунта сюда не нужен.'}</p><button type="button" className="sc-text-button" onClick={() => openLink('https://developers.soundcloud.com/docs/api/guide')}>О документации SoundCloud <ExternalLink size={12} /></button></div>
      <div className="sc-credential-fields"><label>Client ID<input type="password" autoComplete="off" spellCheck={false} value={clientId} onChange={event => { setClientId(event.target.value); setSaved(false); }} placeholder={status?.configured ? 'Оставить прежний' : 'Client ID приложения'} disabled={busy} /></label><label>Client Secret<input type="password" autoComplete="new-password" spellCheck={false} value={clientSecret} onChange={event => { setClientSecret(event.target.value); setSaved(false); }} placeholder={status?.configured ? 'Оставить прежний' : 'Client Secret приложения'} disabled={busy} /></label></div>
      {status?.configured && !editProxy ? <div className="sc-proxy-summary"><span>{status.proxy ? 'Прокси сохранён. Адрес и пароль скрыты.' : 'SoundCloud подключается напрямую.'}</span><button type="button" className="sc-text-button" onClick={() => setEditProxy(true)} disabled={busy}>Изменить маршрут</button></div> : <label className="sc-proxy-field">Прокси для SoundCloud<input type="password" autoComplete="off" spellCheck={false} value={proxy} onChange={event => { setProxy(event.target.value); setSaved(false); }} placeholder="http://логин:пароль@сервер:порт" disabled={busy} /><small>Пустое поле — прямое соединение. Этот маршрут применяется только к SoundCloud. VK подключается напрямую.</small></label>}
      <p className="sc-private-note"><ShieldCheck size={14} /> Ключи хранятся в защищённом хранилище системы. Сохранение настроек ещё не подтверждает доступ API — он проверяется при поиске.</p>
      {error && <p className="sc-message is-error" role="alert">{error}</p>}{saved && <p className="sc-message" role="status"><Check size={14} /> Настройки сохранены</p>}
      <div className="sc-form-actions"><button type="submit" className="primary-button" disabled={busy || !window.desktop?.configureSoundCloud}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{busy ? 'Сохраняем' : 'Сохранить подключение'}</button></div>
    </form>
  </section>;
}

const matchLabel = (item: RankedSourceCandidate) => item.quality === 'exact' ? 'Совпадают данные' : item.quality === 'review' ? 'Нужно проверить версию' : 'Другая запись';
const editionLabel = (candidate: SoundCloudCandidate) => {
  const edition = recordingCensorship(candidate);
  return edition === 'explicit' ? 'Explicit' : edition === 'clean' ? 'Clean' : 'Версия без пометки';
};
const matchWarnings = (item: RankedSourceCandidate) => {
  const labels: Partial<Record<RankedSourceCandidate['reasons'][number], string>> = {
    artist: 'Исполнитель отличается от данных VK.', title: 'Название отличается от данных VK.',
    version: 'Обозначение версии отличается: это может быть другой ремикс, live или edit.',
    duration: 'Длительность отличается от записи VK.', 'duration-unknown': 'Не хватает данных о длительности.',
    censorship: 'Пометки Explicit и Clean не совпадают.', 'censorship-unknown': 'Пометка Explicit или Clean не подтверждена.',
    isrc: 'Идентификатор записи ISRC отличается.', 'metadata-conflict': 'В данных источника есть противоречие.',
  };
  return item.reasons.flatMap(reason => labels[reason] ? [labels[reason]!] : []).join(' ');
};
type TrackSourceProps = { track: Track; onChanged?: () => void; preferExplicit?: boolean };

export function SoundCloudTrackSource({ track, onChanged, preferExplicit = true }: TrackSourceProps) {
  const [binding, setBinding] = useState<SoundCloudBinding | null>(null), [configured, setConfigured] = useState<boolean | null>(null);
  const [artist, setArtist] = useState(track.artist), [title, setTitle] = useState(track.title), [version, setVersion] = useState(track.version || '');
  const [candidates, setCandidates] = useState<SoundCloudCandidate[]>([]), [searched, setSearched] = useState(false), [busy, setBusy] = useState<'load' | 'search' | 'resolve' | 'bind' | null>('load');
  const [mode, setMode] = useState<'search' | 'url'>('search'), [sourceUrl, setSourceUrl] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null), [error, setError] = useState(''), [message, setMessage] = useState('');
  const generation = useRef(0), alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const run = ++generation.current;
    setBinding(null); setConfigured(null); setCandidates([]); setSearched(false); setPendingId(null); setError(''); setMessage(''); setBusy('load');
    setArtist(track.artist); setTitle(track.title); setVersion(track.version || '');
    setMode('search'); setSourceUrl('');
    Promise.all([window.desktop?.soundCloudBinding?.(track.id) ?? null, window.desktop?.soundCloudStatus?.() ?? null]).then(([source, status]) => {
      if (alive.current && run === generation.current) { setBinding(source); setConfigured(status?.configured ?? false); }
    }, cause => { if (alive.current && run === generation.current) setError(failure(cause)); }).finally(() => { if (alive.current && run === generation.current) setBusy(null); });
    return () => { alive.current = false; generation.current++; };
  }, [track.id, track.artist, track.title, track.version]);
  const ranking = useMemo(() => rankSoundCloudCandidates(track, candidates, { preferExplicit, ...(binding && binding.selection !== 'metadata' ? { confirmed: { trackId: track.id, sourceId: binding.id } } : {}) }), [track, candidates, preferExplicit, binding]);
  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !window.desktop?.searchSoundCloud) return;
    const query = [artist.trim(), title.trim(), version.trim()].filter(Boolean).join(' ');
    if (!artist.trim() || !title.trim()) { setError('Укажите исполнителя и название, чтобы искать нужную запись.'); return; }
    const run = ++generation.current;
    setBusy('search'); setError(''); setMessage(''); setPendingId(null); setCandidates([]); setSearched(false);
    try {
      const response = await window.desktop.searchSoundCloud(query);
      if (alive.current && run === generation.current) { setCandidates(response.collection); setSearched(true); }
    } catch (cause) { if (alive.current && run === generation.current) setError(failure(cause)); }
    finally { if (alive.current && run === generation.current) setBusy(null); }
  };
  const resolveLink = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !window.desktop?.resolveSoundCloudCandidate) return;
    let url: URL;
    try {
      url = new URL(sourceUrl.trim());
      if (url.protocol !== 'https:' || !['soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com'].includes(url.hostname) || url.username || url.password) throw new Error('invalid');
    } catch { setError('Вставьте HTTPS-ссылку на трек SoundCloud.'); return; }
    const run = ++generation.current;
    setBusy('resolve'); setError(''); setMessage(''); setPendingId(null); setCandidates([]); setSearched(false);
    try {
      // The native API resolves the actual provider entity. Never derive its
      // recording title, artist or identity from the URL slug.
      const candidate = await window.desktop.resolveSoundCloudCandidate(url.href);
      if (alive.current && run === generation.current) { setCandidates([candidate]); setSearched(true); }
    } catch (cause) { if (alive.current && run === generation.current) setError(failure(cause)); }
    finally { if (alive.current && run === generation.current) setBusy(null); }
  };
  const clearResults = () => { setPendingId(null); setCandidates([]); setSearched(false); setError(''); setMessage(''); };
  const bind = async (candidate: SoundCloudCandidate | null) => {
    if (busy || !window.desktop?.bindSoundCloud) return;
    const run = generation.current;
    setBusy('bind'); setError(''); setMessage('');
    try {
      await window.desktop.bindSoundCloud(track.id, candidate?.id ?? null);
      if (!alive.current || run !== generation.current) return;
      setBinding(candidate); setPendingId(null); setMessage(candidate ? 'Источник сохранён для этого трека.' : 'Привязка удалена.'); onChanged?.();
    } catch (cause) { if (alive.current && run === generation.current) setError(failure(cause)); }
    finally { if (alive.current && run === generation.current) setBusy(null); }
  };
  const pending = candidates.find(item => item.id === pendingId);
  const pendingMatch = ranking.candidates.find(item => item.candidate.id === pendingId);
  return <section className="sc-track-source" aria-label="Источник SoundCloud">
    <div className="sc-source-heading"><span className="sc-service-icon"><Cloud size={20} /></span><div><h3>Источник звука</h3><p>Выберите запись из SoundCloud для этого трека.</p></div></div>
    {binding && <div className="sc-bound-source"><Link2 size={16} /><div><strong>{binding.title}</strong><span>{binding.artist}{binding.version ? ` (${binding.version})` : ''}</span><small>SoundCloud · {time(binding.duration)} · {editionLabel(binding)}</small><small>{binding.selection === 'metadata' ? 'Подобрано автоматически по данным записи' : 'Выбрано вами'}</small></div><button type="button" className="icon-button" disabled={!!busy} onClick={() => void bind(null)} aria-label="Убрать источник SoundCloud" title="Убрать источник SoundCloud"><Unlink size={16} /></button></div>}
    {configured === false && <><p className="sc-message">Сначала настройте SoundCloud: «Настройки» → «Источники музыки».</p><SoundCloudApiGuide /></>}
    <div className="sc-source-modes" role="group" aria-label="Способ поиска источника"><button type="button" className={mode === 'search' ? 'is-selected' : ''} aria-pressed={mode === 'search'} disabled={!!busy} onClick={() => { setMode('search'); clearResults(); }}><Search size={14} /> Поиск</button><button type="button" className={mode === 'url' ? 'is-selected' : ''} aria-pressed={mode === 'url'} disabled={!!busy} onClick={() => { setMode('url'); clearResults(); }}><Link2 size={14} /> По ссылке</button></div>
    {mode === 'search' ? <form className="sc-search-form" onSubmit={event => void search(event)}><div className="sc-search-fields"><label>Исполнитель<input value={artist} onChange={event => { setArtist(event.target.value); clearResults(); }} disabled={!!busy} maxLength={200} /></label><label>Название<input value={title} onChange={event => { setTitle(event.target.value); clearResults(); }} disabled={!!busy} maxLength={300} /></label><label>Версия<input value={version} onChange={event => { setVersion(event.target.value); clearResults(); }} placeholder="Например, remix или live" disabled={!!busy} maxLength={200} /></label></div><button type="submit" className="secondary-button" disabled={!!busy || !configured || !window.desktop?.searchSoundCloud}>{busy === 'search' || busy === 'load' ? <LoaderCircle size={15} className="spin" /> : <Search size={15} />}{busy === 'search' ? 'Ищем записи' : 'Найти в SoundCloud'}</button></form> : <form className="sc-search-form" onSubmit={event => void resolveLink(event)}><label>Ссылка на трек SoundCloud<input type="url" inputMode="url" value={sourceUrl} onChange={event => { setSourceUrl(event.target.value); clearResults(); }} placeholder="https://soundcloud.com/artist/track" disabled={!!busy} maxLength={8192} spellCheck={false} autoComplete="off" /></label><p className="sc-results-note">Pulse получит название, исполнителя и длительность из SoundCloud. Затем вы сможете проверить запись и подтвердить выбор.</p><button type="submit" className="secondary-button" disabled={!!busy || !configured || !sourceUrl.trim() || !window.desktop?.resolveSoundCloudCandidate}>{busy === 'resolve' ? <LoaderCircle size={15} className="spin" /> : <Link2 size={15} />}{busy === 'resolve' ? 'Проверяем ссылку' : 'Проверить ссылку'}</button></form>}
    {error && <p className="sc-message is-error" role="alert">{error}</p>}{message && <p className="sc-message" role="status">{message}</p>}
    {searched && !candidates.length && <p className="sc-search-empty">Записей не найдено. Проверьте исполнителя, название и обозначение версии.</p>}
    {!!candidates.length && <div className="sc-search-results"><p className="sc-results-note">{ranking.status === 'ambiguous' ? 'Есть несколько похожих записей. Сравните версию и длительность.' : 'Совпадение данных помогает с поиском. Выбор другой записи нужно подтвердить.'}</p><ul>{ranking.candidates.map(item => <li key={item.candidate.id} className={`sc-result ${binding?.id === item.candidate.id ? 'is-bound' : ''}`}><span className="sc-result-icon"><Cloud size={19} /></span><div className="sc-result-copy"><strong>{item.candidate.title}</strong><span>{item.candidate.artist}{item.candidate.version ? ` (${item.candidate.version})` : ''}</span><small>{time(item.candidate.duration)}{item.durationDifference !== undefined && item.durationDifference > 2 ? ` · разница ${Math.round(item.durationDifference)} сек` : ''}</small><div className="sc-result-badges"><span className={`sc-match-${item.quality}`}>{matchLabel(item)}</span><span>{editionLabel(item.candidate)}</span>{item.candidate.streamable === false && <span>Нет полного воспроизведения</span>}</div></div><div className="sc-result-actions">{item.candidate.permalinkUrl && <button type="button" className="icon-button" onClick={() => openLink(item.candidate.permalinkUrl)} aria-label={`Открыть ${item.candidate.title} в SoundCloud`} title="Открыть в SoundCloud"><ExternalLink size={14} /></button>}<button type="button" className="secondary-button" disabled={!!busy || item.candidate.streamable === false || binding?.id === item.candidate.id} onClick={() => setPendingId(item.candidate.id)}>{binding?.id === item.candidate.id ? <><Check size={14} /> Выбран</> : 'Выбрать'}</button></div></li>)}</ul></div>}
    {pending && <div className="sc-selection-confirm" role="group" aria-label="Подтвердить источник"><div><strong>Использовать эту запись?</strong><p>{pending.artist} — {pending.title}{pending.version ? ` (${pending.version})` : ''}<br />{time(pending.duration)}. Библиотека и плейлисты VK сохранят свои треки.</p>{pendingMatch && pendingMatch.quality !== 'exact' && <p className="sc-selection-warning">{matchWarnings(pendingMatch)} Проверьте запись перед подтверждением.</p>}</div><div><button type="button" className="secondary-button" disabled={!!busy} onClick={() => setPendingId(null)}>Отмена</button><button type="button" className="primary-button" disabled={!!busy} onClick={() => void bind(pending)}>{busy === 'bind' ? <LoaderCircle size={14} className="spin" /> : <Link2 size={14} />} Использовать запись</button></div></div>}
  </section>;
}
