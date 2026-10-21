import type { CSSProperties } from 'react'
import { Check, Monitor, Palette } from 'lucide-react'
import type { AppSettings } from './shared/contracts'
import { THEME_PALETTES, accentInk, findPalette, type ThemePalette } from './themes'
import './ThemeSettings.css'

type Props = { settings: AppSettings; onChange: (patch: Partial<AppSettings>) => void }

function ThemePreview({ theme }: { theme: ThemePalette }) {
  return <span className={`theme-preview theme-preview-${theme.id}`} aria-hidden="true" style={{ '--preview-bg': theme.colors.bg, '--preview-panel': theme.colors.panel, '--preview-line': theme.colors.line, '--preview-ink': theme.colors.text, '--preview-accent': theme.accent, '--preview-radius': `${Math.max(2, (theme.radius || 16) / 3)}px` } as CSSProperties}>
    <span className="theme-preview-sidebar"><i /><i /><i /><i /></span>
    <span className="theme-preview-main"><span className="theme-preview-title" /><span className="theme-preview-track"><b /><i /><em /></span><span className="theme-preview-track"><b /><i /><em /></span><span className="theme-preview-track"><b /><i /><em /></span></span>
    <span className="theme-preview-player"><i /><b /><i /><em /></span>
  </span>
}

export function ThemeSettings({ settings, onChange }: Props) {
  const active = settings.theme === 'system' ? undefined : findPalette(settings.palette) || findPalette(settings.theme === 'light' ? 'porcelain' : settings.theme === 'high-contrast' ? 'contrast' : 'graphite')
  return <section className="settings-section themes-settings" aria-label="Темы">
    <div className="settings-section-heading"><h2>Темы</h2><p>Пятнадцать настроений для вашей музыки. Тема применяется сразу.</p></div>
    <button type="button" className={`theme-system-option ${settings.theme === 'system' ? 'selected' : ''}`} aria-pressed={settings.theme === 'system'} onClick={() => onChange({ theme: 'system', palette: undefined, accent: '#bdff62' })}>
      <Monitor size={21} /><span><strong>Вслед за Windows</strong><small>Светлая или тёмная тема по настройкам системы</small></span>{settings.theme === 'system' && <Check size={18} />}
    </button>
    {(['basic', 'creative'] as const).map(family => <div className="theme-family" key={family}>
      <div className="theme-family-heading"><h3>{family === 'basic' ? 'Базовые' : 'Характерные'}</h3><span>{THEME_PALETTES.filter(theme => theme.family === family).length}</span></div>
      <div className="theme-gallery">{THEME_PALETTES.filter(theme => theme.family === family).map(theme => <button type="button" className={`theme-option ${active?.id === theme.id ? 'selected' : ''}`} aria-pressed={active?.id === theme.id} aria-label={`Тема ${theme.name}`} key={theme.id} onClick={() => onChange({ palette: theme.id, theme: theme.mode, accent: theme.accent })}>
        <ThemePreview theme={theme} /><span className="theme-option-copy"><strong>{theme.name}</strong><small>{theme.description}</small></span>{active?.id === theme.id && <span className="theme-selected-mark"><Check size={13} /></span>}
      </button>)}</div>
    </div>)}
    <div className="setting-card theme-accent-card"><div className="setting-card-copy"><strong><Palette size={15} /> Свой акцент</strong><p>Цвет кнопок и прогресса можно изменить внутри любой темы.</p></div><div className="theme-accent-options">{['#bdff62', '#8da8ff', '#ff9878', '#cf9aff', '#8de8da', '#ff88d6', '#f4f656'].map(color => <button type="button" key={color} className="theme-accent-button" aria-label={`Акцент ${color}`} aria-pressed={settings.accent.toLowerCase() === color} style={{ background: color, color: accentInk(color) }} onClick={() => onChange({ accent: color })}>{settings.accent.toLowerCase() === color && <Check size={15} />}</button>)}<label className="theme-custom-accent"><span>Другой цвет</span><input aria-label="Свой акцентный цвет" type="color" value={/^#[0-9a-f]{6}$/i.test(settings.accent) ? settings.accent : '#bdff62'} onChange={event => onChange({ accent: event.target.value })} /></label></div></div>
    <p className="theme-footnote">Все темы используют одинаковое управление. Обложки и настройки плотности сохраняются при переключении.</p>
  </section>
}
