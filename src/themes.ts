import type { AppSettings } from './shared/contracts'

export type ThemePalette = {
  id: string; name: string; description: string; family: 'basic' | 'creative'
  mode: 'dark' | 'light' | 'high-contrast'; accent: string
  colors: { bg: string; panel: string; panel2: string; panel3: string; line: string; text: string; muted: string; subtle: string }
  radius?: number
}

const palette = (id: string, name: string, description: string, mode: ThemePalette['mode'], accent: string, colors: string[], radius = 16, family: ThemePalette['family'] = 'creative'): ThemePalette => ({
  id, name, description, mode, accent, radius, family,
  colors: { bg: colors[0], panel: colors[1], panel2: colors[2], panel3: colors[3], line: colors[4], text: colors[5], muted: colors[6], subtle: colors[7] },
})

export const THEME_PALETTES: readonly ThemePalette[] = [
  palette('graphite', 'Графит', 'Спокойный тёмный', 'dark', '#bdff62', ['#0c0e10', '#15181b', '#1d2226', '#283037', '#343e45', '#f2f5f6', '#a5afb7', '#929da5'], 16, 'basic'),
  palette('porcelain', 'Фарфор', 'Воздух и мягкий свет', 'light', '#366839', ['#f4f5f1', '#ffffff', '#edf0e9', '#e2e8dd', '#cbd3c6', '#20271f', '#566050', '#65705e'], 16, 'basic'),
  palette('contrast', 'Контраст', 'Чёткие границы', 'high-contrast', '#ffff70', ['#000000', '#000000', '#111111', '#242424', '#c8c8c8', '#ffffff', '#eeeeee', '#cccccc'], 10, 'basic'),
  palette('retro', 'Кассета', 'Тёплый аналоговый вечер', 'dark', '#f3bd74', ['#211b1a', '#2b2321', '#382b25', '#49372c', '#685044', '#fff1dd', '#ceb59e', '#baa48f'], 7),
  palette('cyberpunk', 'Киберпанк', 'Жёлтый сигнал на асфальте', 'dark', '#f4f656', ['#11121b', '#191b29', '#23273c', '#31384d', '#424d66', '#f4f4fd', '#abb6d5', '#95a4c4'], 5),
  palette('neon', 'Неон', 'Лазерный розовый и мята', 'dark', '#ff88d6', ['#130c1a', '#1f1429', '#2d1c3c', '#40294d', '#58376b', '#fff1fb', '#c9acd3', '#b99ac4'], 19),
  palette('aurora', 'Аврора', 'Холодный свет севера', 'dark', '#8de8da', ['#0b181c', '#10262b', '#17343b', '#22454e', '#315c63', '#eafcf9', '#a0c5c6', '#90b6b9'], 21),
  palette('deepsea', 'Батискаф', 'Глубокий синий океан', 'dark', '#8bbdff', ['#09121f', '#101f32', '#172b43', '#213b55', '#35516c', '#edf5ff', '#a6bdd4', '#90a9c2'], 17),
  palette('forest', 'Хвойный', 'Тихая зелень и туман', 'dark', '#b3d6a2', ['#111a15', '#1a271e', '#26352a', '#33463a', '#4b6050', '#edf4e9', '#afc0ab', '#9aaf97'], 20),
  palette('desert', 'Дюна', 'Песок, глина и охра', 'light', '#995321', ['#f2e8d8', '#faf4e9', '#eadcc8', '#ddc8ad', '#c7ae90', '#392c20', '#6c5842', '#79644c'], 19),
  palette('blossom', 'Сакура', 'Розовое утро', 'light', '#9a3e68', ['#f9edf1', '#fff9fb', '#f2dfe8', '#eacbdc', '#d7adc2', '#412635', '#7a5267', '#856075'], 23),
  palette('paper', 'Бумага', 'Чернила и архивный лист', 'light', '#2c5f72', ['#efeee7', '#f9f8f1', '#e8e6dc', '#dad8ca', '#bebfb1', '#282d2b', '#575f59', '#657066'], 5),
  palette('midnight', 'Полночь', 'Индиго после заката', 'dark', '#b9b4ff', ['#121323', '#1c1e33', '#282a45', '#343855', '#4d5271', '#f0efff', '#b5b5d2', '#a1a3c0'], 18),
  palette('ember', 'Уголь и медь', 'Глубина с тёплым акцентом', 'dark', '#ffa27e', ['#1b1211', '#291c1a', '#382623', '#4a3330', '#654741', '#fff1eb', '#d2aea4', '#bf9b91'], 14),
  palette('ultraviolet', 'Ультрафиолет', 'Космический фиолетовый', 'dark', '#d0a0ff', ['#170e26', '#251638', '#34224c', '#483162', '#64447e', '#f9f0ff', '#cbb0e3', '#b79bd0'], 22),
]

export function findPalette(id?: string): ThemePalette | undefined { return THEME_PALETTES.find(theme => theme.id === id) }

export function accentInk(value: string): '#11130f' | '#ffffff' {
  const rgb = /^#[0-9a-f]{6}$/i.test(value) ? [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16) / 255) : [0.74, 1, 0.38]
  const [red, green, blue] = rgb.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
  const luminance = .2126 * red + .7152 * green + .0722 * blue
  return (luminance + .05) / .056 > 1.05 / (luminance + .05) ? '#11130f' : '#ffffff'
}

function luminance(value: string): number {
  const channels = [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16) / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2]
}

/** Keep accent text readable even when a bright custom colour is chosen on paper. */
export function accentForeground(value: string, background: string): string {
  const base = luminance(background)
  const contrast = (color: string) => (Math.max(luminance(color), base) + .05) / (Math.min(luminance(color), base) + .05)
  if (contrast(value) >= 4.5) return value
  const target = contrast('#000000') >= contrast('#ffffff') ? 0 : 255
  for (let amount = .05; amount <= 1; amount += .05) {
    const candidate = `#${[1, 3, 5].map(index => Math.round(parseInt(value.slice(index, index + 2), 16) * (1 - amount) + target * amount).toString(16).padStart(2, '0')).join('')}`
    if (contrast(candidate) >= 4.5) return candidate
  }
  return target ? '#ffffff' : '#000000'
}

/** Called only when appearance settings change; playback progress never repaints the theme. */
export function applyTheme(settings: AppSettings): () => void {
  const root = document.documentElement
  const preference = window.matchMedia('(prefers-color-scheme: light)')
  const apply = () => {
    const fallback = settings.theme === 'light' ? 'porcelain' : settings.theme === 'high-contrast' ? 'contrast' : 'graphite'
    const theme = settings.theme === 'system' ? findPalette(preference.matches ? 'porcelain' : 'graphite')! : findPalette(settings.palette) || findPalette(fallback)!
    root.dataset.theme = theme.mode
    root.dataset.palette = theme.id
    root.dataset.style = settings.style
    root.classList.toggle('style-minimal', settings.style === 'minimal')
    root.classList.toggle('style-compact', settings.style === 'compact')
    root.classList.toggle('style-album', settings.style === 'album')
    root.classList.toggle('style-soft', settings.style === 'soft')
    root.classList.toggle('reduced-motion', settings.reducedMotion)
    root.classList.toggle('density-compact', settings.density === 'compact')
    root.style.colorScheme = theme.mode === 'light' ? 'light' : 'dark'
    const colors = theme.colors
    const accent = /^#[0-9a-f]{6}$/i.test(settings.accent) ? settings.accent : theme.accent
    const tokens: Record<string, string> = { '--bg': colors.bg, '--panel': colors.panel, '--panel-2': colors.panel2, '--panel-3': colors.panel3, '--line': colors.line, '--text': colors.text, '--muted': colors.muted, '--subtle': colors.subtle, '--accent': accent, '--accent-ink': accentInk(accent), '--accent-fg': accentForeground(accent, colors.panel), '--radius': `${theme.radius}px`, '--text-scale': String(Math.max(.85, Math.min(1.35, settings.textScale || 1))), '--shadow': theme.mode === 'light' ? '0 16px 45px #2530270b' : theme.mode === 'high-contrast' ? 'none' : '0 16px 54px #00000030', '--danger': theme.mode === 'light' ? '#a72b37' : '#ffaca1' }
    for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value)
  }
  apply()
  preference.addEventListener('change', apply)
  return () => preference.removeEventListener('change', apply)
}
