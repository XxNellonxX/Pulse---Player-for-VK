// Independent tests against the gateway's actual input/security functions.
// No public DNS, real credentials, provider requests or native profile.
import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublicAddress, validateTarget, publicPermalink, trackId, queryText, allowedQuery, validateRange } from '../services/pulse-gateway/src/security.mjs';
import { loadConfig } from '../services/pulse-gateway/src/config.mjs';

test('IPv4 and canonical compressed IPv6 special addresses are never provider destinations', () => {
  for (const address of [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.168.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
    '::', '::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', 'fc00::1', 'fe80::1', 'ff02::1',
    '2001::1', '2001:0000::1', '2001:db8::1', '2002:7f00:1::1', '3fff::1',
  ]) assert.equal(isPublicAddress(address), false, 'Special address accepted: ' + address);
  for (const address of ['1.1.1.1', '8.8.8.8', '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true);
});

test('all upstream kinds reject URL credentials, secret query parameters and private/custom origins', () => {
  for (const kind of ['token', 'api', 'musicbrainz', 'media']) {
    for (const url of [
      'http://api.soundcloud.com/tracks', 'https://127.0.0.1/', 'https://[::1]/', 'file:///secret',
      'https://api.soundcloud.com.evil.example/tracks', 'https://evil.example/api.soundcloud.com/tracks',
      'https://user:private@api.soundcloud.com/tracks', 'https://api.soundcloud.com:444/tracks',
      'https://api.soundcloud.com/tracks#secret', 'https://api.soundcloud.com/tracks?access_token=private',
      'https://api.soundcloud.com/tracks?CLIENT_SECRET=private', 'https://api.soundcloud.com/tracks?%61ccess_token=private',
      'https://api.soundcloud.com/tracks?oauth_token=private', 'https://api.soundcloud.com/tracks?authorization=private',
    ]) assert.throws(() => validateTarget(url, kind), undefined, kind + ' accepted an unsafe URL');
  }
});

test('allowed hosts are constrained to the actual provider API paths', () => {
  const accepted = [
    ['token', 'https://secure.soundcloud.com/oauth/token'],
    ['api', 'https://api.soundcloud.com/tracks?q=test'],
    ['api', 'https://api.soundcloud.com/tracks/123/streams'],
    ['musicbrainz', 'https://musicbrainz.org/ws/2/artist/?query=test&fmt=json'],
    ['media', 'https://cf-media.sndcdn.com/fixture.mp3?Policy=synthetic'],
    ['media', 'https://api.soundcloud.com/tracks/soundcloud:tracks:123/streams/00000000-0000-4000-8000-000000000000/hls'],
    ['media', 'https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A123/streams/fixture-grant/hls/'],
  ];
  for (const [kind, url] of accepted) assert.equal(validateTarget(url, kind).protocol, 'https:');
  for (const [kind, url] of [
    ['token', 'https://secure.soundcloud.com/oauth/other'], ['api', 'https://api.soundcloud.com/users/1'],
    ['musicbrainz', 'https://musicbrainz.org/admin'], ['media', 'https://api.soundcloud.com/resolve?url=private'],
    ['media', 'https://sndcdn.com.evil.example/audio.mp3'], ['media', 'https://evil.example/audio.mp3'],
    ['media', 'https://api.soundcloud.com/tracks/123/streams/grant/download'],
    ['media', 'https://api.soundcloud.com/tracks/123/streams/grant/hls/other'],
    ['media', 'https://api.soundcloud.com/tracks/123/streams/grant%2fhls'],
  ]) assert.throws(() => validateTarget(url, kind));
});

test('public SoundCloud URL handling never accepts private capability links or arbitrary fetch targets', () => {
  for (const url of [
    'https://soundcloud.com/artist/song?secret_token=private', 'https://soundcloud.com/artist/song?url=https://127.0.0.1',
    'https://user:private@soundcloud.com/artist/song', 'https://soundcloud.com:444/artist/song',
    'http://soundcloud.com/artist/song', 'https://soundcloud.com.evil.example/artist/song',
    'https://127.0.0.1/audio.mp3', 'https://soundcloud.com/artist/song/extra',
  ]) assert.throws(() => publicPermalink(url));
  assert.equal(publicPermalink('https://soundcloud.com/artist/song'), 'https://soundcloud.com/artist/song');
});

test('track identity, query duplicates and byte ranges cannot expand the gateway request surface', () => {
  for (const id of ['0', '-1', '1/streams', '1?url=evil', '1e9', '123456789012345678901', 'soundcloud:users:123']) assert.throws(() => trackId(id));
  assert.equal(trackId('soundcloud:tracks:123'), '123');
  for (const value of ['', ' \n ', 'test\u0000private', 'x'.repeat(201)]) assert.throws(() => queryText(value));
  for (const value of ['q=a&q=b', 'q=a&url=private', 'q=a&access_token=private']) assert.throws(() => allowedQuery(new URLSearchParams(value), ['q']));
  for (const range of ['bytes=-1', 'bytes=0-1,2-3', 'bytes=2-1', 'bytes=0-8388608', 'bytes=9007199254740992-', 'items=0-1']) assert.throws(() => validateRange(range));
  assert.equal(validateRange('bytes=0-1023'), 'bytes=0-1023');
});

test('server configuration cannot accidentally expose a public unauthenticated bind or embed placeholder keys', () => {
  const valid = { PUBLIC_ORIGIN: 'https://gateway.example.org', SOUNDCLOUD_CLIENT_ID: 'fixture-id', SOUNDCLOUD_CLIENT_SECRET: 'fixture-private-secret' };
  assert.equal(loadConfig(valid).host, '127.0.0.1');
  for (const patch of [
    { HOST: '0.0.0.0' }, { PUBLIC_ORIGIN: 'http://gateway.example.org' }, { PUBLIC_ORIGIN: 'https://gateway.example.org/private' },
    { PUBLIC_ORIGIN: 'https://user:private@gateway.example.org' }, { SOUNDCLOUD_CLIENT_SECRET: 'PASTE_CLIENT_SECRET_HERE' },
    { SOUNDCLOUD_CLIENT_ID: '' }, { PORT: '0' }, { MAX_GLOBAL_CONCURRENT: '999999' },
  ]) assert.throws(() => loadConfig({ ...valid, ...patch }));
});
