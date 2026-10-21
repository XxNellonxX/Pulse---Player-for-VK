import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
const state = { version: 1, tracks: Array.from({ length: 35 }, (_, index) => ({ id: `fixture-${index}`, title: ['Линия горизонта', 'Северный ветер', 'Untitled morning', 'Невесомость', 'Электрические сны'][index % 5], artist: ['Спектр', 'Northern lights', 'Сигнал', 'Мира', 'Cassette club'][index % 5], album: index % 4 === 0 ? 'Параллели' : '', duration: 187 + index, artwork: index === 2 ? 'http://127.0.0.1:5173/missing-fixture-cover.png' : undefined, url: '', source: 'local', addedAt: Date.now() - index * 1000, available: true })), playlists: [], queue: Array.from({ length: 35 }, (_, index) => `fixture-${index}`), history: [], currentTrackId: 'fixture-0', position: 72, settings: { theme: 'dark', palette: 'graphite', accent: '#bdff62', style: 'minimal', density: 'comfortable', textScale: 1, reducedMotion: false, volume: .54, repeat: 'off', shuffle: false, closeToTray: false, autoplay: false, autoSkip: true } }
const wav = Buffer.alloc(44 + 8000 * 2 * 240)
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
state.tracks.forEach(track => { track.url = 'http://127.0.0.1:5173/__qa/silence.wav' })
await page.route('**/__qa/silence.wav', route => route.fulfill({ contentType: 'audio/wav', body: wav }))
await page.addInitScript(value => localStorage.setItem('pulse-preview', JSON.stringify(value)), state)
const output = new URL('./theme-visual/', import.meta.url)
await mkdir(output, { recursive: true })
const checks = []
try {
  await page.goto('http://127.0.0.1:5173/')
  await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  await page.getByRole('button', { name: 'Темы', exact: true }).click()
  await page.getByRole('button', { name: 'Тема Графит', exact: true }).waitFor()
  for (const name of ['Графит', 'Фарфор', 'Контраст', 'Кассета', 'Киберпанк', 'Неон', 'Аврора', 'Батискаф', 'Хвойный', 'Дюна', 'Сакура', 'Бумага', 'Полночь', 'Уголь и медь', 'Ультрафиолет']) {
    await page.getByRole('button', { name: `Тема ${name}`, exact: true }).click()
    await page.waitForTimeout(35)
    assert.equal(await page.getByRole('button', { name: `Тема ${name}`, exact: true }).getAttribute('aria-pressed'), 'true')
    const report = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
      return { palette: document.documentElement.dataset.palette, theme: document.documentElement.dataset.theme, accent: root.getPropertyValue('--accent').trim(), ink: root.getPropertyValue('--accent-ink').trim(), horizontalOverflow: document.body.scrollWidth > innerWidth, bodyText: getComputedStyle(document.body).color, headingText: getComputedStyle(document.querySelector('h1')).color, tokenText: root.color, galleryColumns: getComputedStyle(document.querySelector('.theme-gallery')).gridTemplateColumns }
    })
    assert.equal(report.horizontalOverflow, false)
    assert.equal(report.headingText, report.tokenText, 'Theme headings must use the current text colour')
    assert.equal(report.bodyText, report.tokenText, 'Theme body must use the current text colour')
    checks.push({ name, ...report })
    if (['Фарфор', 'Киберпанк', 'Кассета'].includes(name)) {
      await page.locator('.content-scroll').evaluate(element => { element.scrollTop = 0 })
      await page.screenshot({ path: fileURLToPath(new URL(`themes-${report.palette}-1440.png`, output)) })
    }
  }
  await page.getByRole('button', { name: 'Моя музыка', exact: true }).click()
  await page.locator('.content-scroll').evaluate(element => { element.scrollTop = 0 })
  const coverChecks = await page.evaluate(() => ({ count: document.querySelectorAll('.track-cover .abstract-artwork').length, variants: [...new Set([...document.querySelectorAll('.track-cover .abstract-artwork')].map(element => element.classList.value))], duplicates: [...document.querySelectorAll('svg defs [id]')].map(element => element.id).filter((id, index, all) => all.indexOf(id) !== index) }))
  assert.ok(coverChecks.count >= 34)
  assert.ok(coverChecks.variants.length >= 4)
  assert.deepEqual(coverChecks.duplicates, [])
  for (const viewport of [{ width: 1440, height: 900 }, { width: 960, height: 620 }]) {
    await page.setViewportSize(viewport)
    const before = await page.getByLabel('Громкость', { exact: true }).boundingBox()
    await page.getByRole('button', { name: 'Открыть громкость', exact: true }).hover()
    await page.waitForTimeout(250)
    const after = await page.getByLabel('Громкость', { exact: true }).boundingBox()
    const layout = await page.evaluate(() => {
      const b = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x, right:r.right, width:r.width, y:r.y, bottom:r.bottom } }
      return { now:b('.now-playing'), transport:b('.player-controls'), options:b('.player-options'), bodyOverflow:document.body.scrollWidth>innerWidth }
    })
    assert.ok(after.width > 50)
    assert.equal(layout.bodyOverflow, false)
    assert.ok(layout.now.right <= layout.transport.x + 1)
    assert.ok(layout.transport.right <= layout.options.x + 1)
    checks.push({ viewport, volumeBefore: before?.width, volumeAfter: after.width, layout })
    await page.screenshot({ path: fileURLToPath(new URL(`library-${viewport.width}.png`, output)) })
    await page.mouse.move(0, 0)
  }
  await page.getByLabel('Громкость', { exact: true }).focus()
  await page.waitForTimeout(250)
  assert.ok((await page.getByLabel('Громкость', { exact: true }).boundingBox()).width > 50, 'Keyboard focus must reveal volume')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await page.locator('.volume-control input').evaluate(element => getComputedStyle(element).transitionDuration), '0s')
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' })
  await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  await page.getByRole('button', { name: 'Темы', exact: true }).click()
  await page.getByRole('button', { name: 'Вслед за Windows Светлая или тёмная тема по настройкам системы' }).click()
  await page.waitForFunction(() => document.documentElement.dataset.palette === 'graphite')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForFunction(() => document.documentElement.dataset.palette === 'porcelain')
  await page.getByRole('button', { name: 'Тема Кассета', exact: true }).click()
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pulse-preview')).settings.palette), 'retro')
  checks.push({ keyboardVolumeVisible: true, prefersReducedMotionRespected: true, systemThemeLiveChange: true, presetPersisted: true })
  assert.deepEqual(errors, [])
  await writeFile(new URL('result.json', output), JSON.stringify({ checkedAt:new Date().toISOString(), errors, coverChecks, checks },null,2)+'\n')
  console.log('PASS 15 palettes, selected state, abstract covers, HUD layouts and hover volume; screenshots in qa/theme-visual')
} finally { await browser.close() }
