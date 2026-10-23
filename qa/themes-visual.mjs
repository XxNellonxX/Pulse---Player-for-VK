import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const base = process.env.PULSE_QA_URL || 'http://127.0.0.1:5193'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
const state = { version: 1, tracks: Array.from({ length: 35 }, (_, index) => ({ id: `fixture-${index}`, title: ['Линия горизонта', 'Северный ветер', 'Untitled morning', 'Невесомость', 'Электрические сны'][index % 5], artist: ['Спектр', 'Northern lights', 'Сигнал', 'Мира', 'Cassette club'][index % 5], album: index % 4 === 0 ? 'Параллели' : '', duration: 187 + index, artwork: index === 2 ? 'http://127.0.0.1:5173/missing-fixture-cover.png' : undefined, url: '', source: 'local', addedAt: Date.now() - index * 1000, available: true })), playlists: [], queue: Array.from({ length: 35 }, (_, index) => `fixture-${index}`), history: [], currentTrackId: 'fixture-0', position: 72, settings: { theme: 'dark', palette: 'graphite', accent: '#bdff62', style: 'minimal', density: 'comfortable', textScale: 1, reducedMotion: false, volume: .54, repeat: 'off', shuffle: false, closeToTray: false, autoplay: false, autoSkip: true } }
const wav = Buffer.alloc(44 + 8000 * 2 * 240)
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
state.tracks.forEach(track => { track.url = `${base}/__qa/silence.wav` })
await page.route('**/__qa/silence.wav', route => route.fulfill({ contentType: 'audio/wav', body: wav }))
await page.addInitScript(value => localStorage.setItem('pulse-preview', JSON.stringify(value)), state)
const output = new URL('./theme-visual/', import.meta.url)
await mkdir(output, { recursive: true })
const checks = []
try {
  await page.goto(base)
  await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  await page.getByRole('button', { name: 'Темы', exact: true }).click()
  await page.getByRole('button', { name: 'Тема Графит', exact: true }).waitFor()
  for (const name of ['Графит', 'Фарфор', 'Контраст', 'Кассета', 'Киберпанк', 'Неон', 'Аврора', 'Батискаф', 'Хвойный', 'Дюна', 'Сакура', 'Бумага', 'Полночь', 'Уголь и медь', 'Ультрафиолет', 'Y2K / 90-е', 'Стекло']) {
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
    if (['Фарфор', 'Киберпанк', 'Кассета', 'Y2K / 90-е', 'Стекло'].includes(name)) {
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
    await page.getByRole('button', { name: 'Выключить звук', exact: true }).hover()
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
  const volume = page.getByLabel('Громкость', { exact: true })
  await page.getByRole('button', { name: 'Выключить звук', exact: true }).click()
  assert.equal(await volume.inputValue(), '0')
  assert.equal(await page.getByRole('button', { name: 'Включить звук', exact: true }).getAttribute('aria-pressed'), 'true')
  await page.getByRole('button', { name: 'Включить звук', exact: true }).click()
  assert.equal(await volume.inputValue(), '0.54', 'Unmute must restore the previous volume')
  await volume.press('End')
  await page.getByRole('button', { name: 'Выключить звук', exact: true }).press('Enter')
  assert.equal(await volume.inputValue(), '0')
  await page.getByRole('button', { name: 'Включить звук', exact: true }).press('Space')
  assert.equal(await volume.inputValue(), '1', 'Keyboard mute must restore changed volume')
  await volume.press('Home')
  await page.getByRole('button', { name: 'Включить звук', exact: true }).click()
  assert.equal(await volume.inputValue(), '1', 'Dragging to zero must retain the previous nonzero volume')
  checks.push({ muteRestore: true, keyboardMute: true, sliderZeroRestore: true })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await page.locator('.volume-control input').evaluate(element => getComputedStyle(element).transitionDuration), '0s')
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' })
  await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  await page.getByRole('button', { name: 'Темы', exact: true }).click()
  await page.getByRole('button', { name: 'Вслед за системой Светлая или тёмная тема по настройкам системы' }).click()
  await page.waitForFunction(() => document.documentElement.dataset.palette === 'graphite')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForFunction(() => document.documentElement.dataset.palette === 'porcelain')
  await page.getByRole('button', { name: 'Тема Кассета', exact: true }).click()
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pulse-preview')).settings.palette), 'retro')
  checks.push({ keyboardVolumeVisible: true, prefersReducedMotionRespected: true, systemThemeLiveChange: true, presetPersisted: true })
  // Isolate only media time for control tests: this mounts the real production
  // seekbar with React state, without a decoder overriding a synthetic seek.
  const controls = await browser.newPage({ viewport: { width: 960, height: 620 } })
  controls.on('pageerror', error => errors.push(error.message))
  await controls.route(base + '/__appearance-controls-qa', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root" style="width:600px;margin:100px"></div>' }))
  await controls.goto(base + '/__appearance-controls-qa')
  await controls.evaluate(async () => {
    const runtime = (await import('/@react-refresh')).default
    runtime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true
  })
  await controls.evaluate(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const { BufferedSeekbar } = await import('/src/BufferedSeekbar.tsx')
    await import('/src/styles.css')
    function Harness() {
      const [position, setPosition] = React.useState(40)
      return React.createElement(BufferedSeekbar, { trackId: 'control-fixture', position, duration: 240, buffering: false, buffered: [[0,120]], onSeek: setPosition })
    }
    createRoot(document.getElementById('root')).render(React.createElement(Harness))
  })
  const seek = controls.getByLabel('Позиция воспроизведения', { exact: true })
  await seek.waitFor()
  const seekBox = await seek.boundingBox()
  await controls.mouse.move(seekBox.x + seekBox.width * .55, seekBox.y + seekBox.height / 2)
  await controls.mouse.down()
  await controls.mouse.move(seekBox.x + seekBox.width * .7, seekBox.y + seekBox.height / 2)
  await controls.waitForTimeout(160)
  const pointerSeek = await controls.locator('.buffered-seekbar').evaluate(element => ({ outline: getComputedStyle(element).outlineStyle, playheadOutline: getComputedStyle(element.querySelector('.seek-playhead')).outlineStyle, railHeight: parseFloat(getComputedStyle(element.querySelector('.seek-rail')).height) }))
  assert.equal(pointerSeek.outline, 'none', 'Pointer seeking must not add a rectangular focus frame')
  assert.equal(pointerSeek.playheadOutline, 'none', 'Pointer dragging must not show the keyboard focus ring')
  assert.equal(pointerSeek.railHeight, 6, 'Seek rail grows slightly while dragging')
  await controls.mouse.up()
  assert.ok(Number(await seek.inputValue()) > 165, 'Pointer release commits the requested position')
  await seek.press('Home')
  await seek.press('ArrowRight')
  assert.equal(await seek.inputValue(), '5', 'Keyboard seeking remains operable')
  assert.equal(await controls.locator('.seek-playhead').evaluate(element => getComputedStyle(element).outlineStyle), 'solid', 'Keyboard focus remains visible on the playhead')
  await seek.press('End')
  assert.equal(await seek.inputValue(), '240')
  await seek.press('ArrowRight')
  assert.equal(await seek.inputValue(), '240', 'Keyboard seeking remains bounded at duration')
  checks.push({ pointerSeek, keyboardSeek: true })
  await controls.close()
  assert.deepEqual(errors, [])
  await writeFile(new URL('result.json', output), JSON.stringify({ checkedAt:new Date().toISOString(), errors, coverChecks, checks },null,2)+'\n')
  console.log('PASS 17 palettes, selected state, abstract covers, HUD layouts, pointer/keyboard seeking and mute restore; screenshots in qa/theme-visual')
} finally { await browser.close() }
