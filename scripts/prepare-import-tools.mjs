import { mkdir, readFile, writeFile, rename, rm, readdir, copyFile, chmod, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { importToolPackages, importToolSources } from './import-tool-packages.mjs';

const platform = process.platform, arch = process.env.PULSE_IMPORT_ARCH || process.arch;
const packages = importToolPackages(platform, arch);
const toolsDir = path.resolve(process.env.PULSE_IMPORT_TOOLS_DIR || 'src-tauri/resources/import-tools');
await mkdir(toolsDir, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'pulse-import-tools-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function expand(archive, target) {
  await mkdir(target, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', archive, '-C', target], { windowsHide: true, stdio: 'inherit' });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Archive extraction failed: ${code}`)));
  });
}
async function locate(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return candidate;
    if (entry.isDirectory()) { const found = await locate(candidate, name); if (found) return found; }
  }
}
async function ready(item) {
  try {
    if ((await readFile(path.join(toolsDir, `${item.executable}.source-sha256`), 'utf8')).trim() !== item.sha) return false;
    for (const output of item.outputs || [item.executable]) {
      const bytes = await readFile(path.join(toolsDir, output));
      if (!bytes.length) return false;
      const marker = path.join(toolsDir, `${output}.binary-sha256`);
      const digest = (await readFile(marker, 'utf8')).trim();
      if (digest !== sha(bytes)) return false;
      if (!item.name.endsWith('.zip') && digest !== item.sha) return false;
      if (platform !== 'win32' && !item.notice) await chmod(path.join(toolsDir, output), 0o755);
    }
    return true;
  } catch { return false; }
}
try {
  for (const item of packages) {
    if (await ready(item)) { console.log(`Ready ${item.executable}`); continue; }
    console.log(`Downloading ${item.executable} (${platform}/${arch})`);
    const response = await fetch(item.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Tool download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha(bytes) !== item.sha) throw new Error(`Checksum mismatch for ${item.name}; verify the pinned upstream release`);
    const archive = path.join(temporary, item.name);
    await writeFile(archive, bytes);
    if (item.name.endsWith('.zip')) {
      const expanded = path.join(temporary, item.executable + '-expanded');
      await expand(archive, expanded);
      for (const output of item.outputs || [item.executable]) {
        const source = await locate(expanded, output);
        if (!source) throw new Error(`Missing ${output} in verified archive`);
        await copyFile(source, path.join(toolsDir, output));
      }
    } else await rename(archive, path.join(toolsDir, item.executable));
    for (const output of item.outputs || [item.executable]) {
      const target = path.join(toolsDir, output);
      if (platform !== 'win32' && !item.notice) await chmod(target, 0o755);
      await writeFile(path.join(toolsDir, `${output}.binary-sha256`), sha(await readFile(target)) + '\n');
    }
    await writeFile(path.join(toolsDir, `${item.executable}.source-sha256`), item.sha + '\n');
  }
  await writeFile(path.join(toolsDir, 'SOURCES.txt'), importToolSources(platform, arch, packages));
} finally { await rm(temporary, { recursive: true, force: true }); }
