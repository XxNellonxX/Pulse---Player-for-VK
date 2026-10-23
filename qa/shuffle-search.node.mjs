import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function loadTs(file) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64')}`);
}
const { canAttemptPlayback, shuffleIds, ownMusicIds, shuffledQueue, nextShuffledCycle } = await loadTs('../src/shuffle.ts');
const { musicSearchResults } = await loadTs('../src/musicSearch.ts');
const track = (id, extra = {}) => ({ id, title: `Title ${id}`, artist: 'Singer', album: '', duration: 90, source: 'vk', available: true, remote: { inLibrary: true }, ...extra });

test('Fisher–Yates covers every permutation of three tracks equally', () => {
  const counts = new Map();
  for (const first of [0, 1 / 3, 2 / 3]) for (const second of [0, .5]) {
    const choices = [first + .00001, second + .00001];
    const value = shuffleIds(['a', 'b', 'c'], () => choices.shift()).join('');
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  assert.equal(counts.size, 6);
  assert.deepEqual([...counts.values()], [1, 1, 1, 1, 1, 1]);
});

test('full library is shuffled across all ages, excluding unavailable and discovery tracks', () => {
  const tracks = Array.from({ length: 4900 }, (_, index) => track(`id-${index}`, { addedAt: index }));
  tracks.push(track('discovery', { remote: { inLibrary: false } }), track('disabled', { available: false }), track('local', { source: 'local', remote: undefined }));
  const pool = ownMusicIds(tracks);
  const queue = shuffledQueue(pool, 'id-2500', () => .61);
  assert.equal(queue.length, 4901);
  assert.equal(queue[0], 'id-2500');
  assert.equal(new Set(queue).size, 4901);
  assert.ok(queue.includes('id-0') && queue.includes('id-4899') && queue.includes('local'));
  assert.ok(!queue.includes('discovery') && !queue.includes('disabled'));
});

test('cycle restarts include every track and avoid repeating the previous last track immediately', () => {
  const queue = nextShuffledCycle(['a', 'b', 'c'], 'a', () => .999);
  assert.notEqual(queue[0], 'a');
  assert.deepEqual([...queue].sort(), ['a', 'b', 'c']);
  assert.deepEqual(shuffleIds(['a', 'a', 'b'], () => 0), ['b', 'a']);
  assert.deepEqual(nextShuffledCycle(['a'], 'a'), ['a']);
  assert.deepEqual(nextShuffledCycle([], null), []);
});

test('VK restrictions keep an independent-source opportunity in the entire queue without enabling missing local files', () => {
  const restricted = track('vk-restricted', { available: false });
  const missing = track('local-missing', { source: 'local', available: false });
  const tracks = [track('normal'), restricted, missing, track('discovery', { available: false, remote: { inLibrary: false } })];
  assert.equal(canAttemptPlayback(restricted, { preferSoundCloud: true }), true);
  assert.equal(canAttemptPlayback(restricted, { preferSoundCloud: false }), false);
  assert.equal(canAttemptPlayback(missing, { preferSoundCloud: true }), false);
  assert.deepEqual(ownMusicIds(tracks, { preferSoundCloud: true }), ['normal', 'vk-restricted']);
  assert.deepEqual(ownMusicIds(tracks, { preferSoundCloud: false }), ['normal']);
  assert.equal(restricted.available, false);
});

test('global search retains VK related matches and provider ordering', () => {
  const own = [track('mine'), track('saved-discovery', { remote: { inLibrary: false } })];
  const remote = [track('related', { title: 'Corrected title', artist: 'Other', remote: { inLibrary: false } }), track('mine')];
  const results = musicSearchResults(own, remote, 'Singer', 'all');
  assert.deepEqual(results.map(item => item.id), ['related', 'mine']);
  assert.equal(results[1].remote.inLibrary, true);
  assert.deepEqual(musicSearchResults(own, remote, 'Singer', 'mine').map(item => item.id), ['mine']);
});

test('known playlist-only track stays outside own music even if global response differs', () => {
  const result = musicSearchResults([track('x', { remote: { inLibrary: false } })], [track('x')], 'unmatched', 'all');
  assert.equal(result.length, 1);
  assert.equal(result[0].remote.inLibrary, false);
});
