import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AtomicStore } from '../electron/storage.mjs';

test('a recovery write keeps a parseable backup instead of copying the corrupt primary', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vk-player-qa-store-'));
  try {
    const store = new AtomicStore(directory);
    await store.write({ schema: 1, files: [], state: { marker: 'good-1' } });
    await store.write({ schema: 1, files: [], state: { marker: 'good-2' } });
    await writeFile(store.file, '{truncated', 'utf8');
    const recovered = await store.read();
    assert.equal(recovered.state.marker, 'good-1');
    assert.equal(store.recovered, true);
    await store.write({ ...recovered, state: { marker: 'good-3' } });
    const backup = JSON.parse(await readFile(`${store.file}.bak`, 'utf8'));
    assert.equal(backup.schema, 1);
    assert.equal(backup.state.marker, 'good-1');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('serialized concurrent writes end with the last submitted snapshot', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vk-player-qa-store-'));
  try {
    const store = new AtomicStore(directory);
    await Promise.all(Array.from({ length: 50 }, (_, marker) => store.write({ schema: 1, files: [], state: { marker } })));
    const saved = await store.read();
    assert.equal(saved.state.marker, 49);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
