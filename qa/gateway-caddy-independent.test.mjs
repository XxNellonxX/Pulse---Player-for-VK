// Independent Caddy configuration regression.  This test never connects to a
// real service and does not read a gateway .env file.  The optional validation
// path is enabled only when CADDY_BINARY is explicitly supplied by a QA job.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const caddyfile = path.join(root, 'services', 'pulse-gateway', 'Caddyfile');

test('Caddy disables request error logging that could contain media capabilities', async () => {
  const source = await readFile(caddyfile, 'utf8');
  assert.match(source, /^\{\s*.*?\blog\s+default\s*\{\s*exclude\s+http\.log\.error\s*\}\s*\}/ms,
    'the global default logger must exclude HTTP reverse-proxy error records');
  assert.doesNotMatch(source, /^\s*log\s*\{/m,
    'the gateway must not enable a site access logger');
  assert.match(source, /reverse_proxy\s+127\.0\.0\.1:8080/);
});

test('real Caddy keeps TLS/startup logs while an unavailable upstream never logs the media capability', async t => {
  const binary = process.env.CADDY_BINARY;
  if (!binary) {
    t.skip('set CADDY_BINARY to run the isolated real reverse-proxy check');
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pulse-caddy-qa-'));
  const env = {
    ...process.env, PULSE_DOMAIN: 'gateway.example.org', ACME_EMAIL: 'qa@example.org',
    XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory, APPDATA: directory, LOCALAPPDATA: directory,
  };
  let child;
  let exited;
  try {
    const result = spawnSync(binary, ['adapt', '--config', caddyfile, '--adapter', 'caddyfile'], {
      cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `caddy adapt failed (${result.status})`);
    const adapted = JSON.parse(result.stdout);
    const logger = adapted.logging.logs.default;
    assert.deepEqual(logger.exclude, ['http.log.error']);
    assert.equal(logger.include, undefined, 'TLS and startup namespaces must remain enabled');
    assert.equal(logger.writer, undefined, 'the default logger must not discard unrelated diagnostics');
    for (const server of Object.values(adapted.apps.http.servers)) {
      assert.equal(server.logs, undefined, 'site access logging must remain disabled');
      assert.equal(server.read_header_timeout, 10_000_000_000, 'external headers must have a finite deadline');
      assert.equal(server.read_timeout, 15_000_000_000);
      assert.equal(server.write_timeout, 60_000_000_000);
      assert.equal(server.idle_timeout, 30_000_000_000);
      assert.equal(server.max_header_bytes, 16_000);
    }

    async function unusedPort() {
      const server = net.createServer();
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = server.address().port;
      await new Promise(resolve => server.close(resolve));
      return port;
    }
    const source = await readFile(caddyfile, 'utf8');
    const globalBlock = /^\{\s*.*?^\}/ms.exec(source)?.[0];
    assert.ok(globalBlock);
    const listenerPort = await unusedPort();
    let unavailablePort = await unusedPort();
    while (unavailablePort === listenerPort) unavailablePort = await unusedPort();
    const fixtureFile = path.join(directory, 'Caddyfile');
    // Only the global logger policy and real reverse-proxy handler are reused.
    // An HTTP fixture avoids certificate issuance and any provider connection.
    const proxy = /^  reverse_proxy\s+127\.0\.0\.1:8080\s*\{.*^  \}/ms.exec(source)?.[0];
    assert.ok(proxy);
    await writeFile(fixtureFile, `${globalBlock}\nhttp://127.0.0.1:${listenerPort} {\n${proxy.replace('127.0.0.1:8080', `127.0.0.1:${unavailablePort}`)}\n}\n`);
    child = spawn(binary, ['run', '--config', fixtureFile, '--adapter', 'caddyfile'], {
      cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    exited = once(child, 'exit');
    let logs = '';
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    const capability = 'a'.repeat(48);
    let status;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${listenerPort}/v1/media/${capability}/0`, { signal: AbortSignal.timeout(1000) });
        status = response.status;
        await response.body?.cancel();
        break;
      } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.equal(status, 502, 'the real reverse proxy must exercise its unavailable-upstream failure path');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(logs.length > 0, 'unrelated Caddy startup diagnostics should still be emitted');
    assert.equal(logs.includes(capability), false, 'Caddy error output leaked the temporary media path');
    assert.equal(logs.includes('http.log.error'), false);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await exited; }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pulse-caddy-qa-'));
    await rm(directory, { recursive: true, force: true });
  }
});
