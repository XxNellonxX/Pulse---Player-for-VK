import { mkdir, readFile, writeFile, rename, rm, readdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// Pinned official distributions. These programs run only during URL imports.
const toolsDir = path.resolve('src-tauri/resources/import-tools');
await mkdir(toolsDir, { recursive: true });
const temporary = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 'pulse-import-tools-')));
const packages = [
  { name: 'yt-dlp.exe', url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe', sha: '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a', executable: 'yt-dlp.exe' },
  { name: 'ffmpeg.zip', url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', sha: '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba', executable: 'ffmpeg.exe' },
  { name: 'deno.zip', url: 'https://github.com/denoland/deno/releases/download/v2.9.7/deno-x86_64-pc-windows-msvc.zip', sha: 'a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238', executable: 'deno.exe' },
];
async function expand(archive, target) {
  await mkdir(target, { recursive: true });
  await new Promise((resolve, reject) => {
    const process = spawn('tar.exe', ['-xf', archive, '-C', target], { windowsHide: true, stdio: 'inherit' });
    process.on('error', reject); process.on('exit', code => code === 0 ? resolve() : reject(new Error(`Archive extraction failed: ${code}`)));
  });
}
async function locate(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return candidate;
    if (entry.isDirectory()) { const found = await locate(candidate, name); if (found) return found; }
  }
}
try {
  for (const item of packages) {
    const marker = path.join(toolsDir, `${item.executable}.source-sha256`);
    try { if ((await readFile(marker, 'utf8')).trim() === item.sha && (await readFile(path.join(toolsDir, item.executable))).length) { console.log(`Ready ${item.executable}`); continue; } } catch {}
    console.log(`Downloading ${item.executable} from its official distribution`);
    const response = await fetch(item.url);
    if (!response.ok) throw new Error(`Tool download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== item.sha) throw new Error(`Checksum mismatch for ${item.name}; update pins after verifying its official release`);
    const archive = path.join(temporary, item.name);
    await writeFile(archive, bytes);
    if (item.name.endsWith('.zip')) {
      const expanded = path.join(temporary, item.executable + '-expanded');
      await expand(archive, expanded);
      for (const name of item.executable === 'ffmpeg.exe' ? ['ffmpeg.exe', 'ffprobe.exe'] : [item.executable]) {
        const source = await locate(expanded, name);
        if (!source) throw new Error(`Missing ${name} in verified archive`);
        await copyFile(source, path.join(toolsDir, name));
      }
    } else await rename(archive, path.join(toolsDir, item.executable));
    await writeFile(marker, item.sha + '\n');
  }
  await writeFile(path.join(toolsDir, 'SOURCES.txt'), 'yt-dlp 2026.08.19: https://github.com/yt-dlp/yt-dlp (Unlicense; packaged third-party notices included in its official distribution)\nDeno 2.9.7: https://github.com/denoland/deno (MIT)\nFFmpeg Windows essentials by gyan.dev: https://www.gyan.dev/ffmpeg/builds/ (GPLv3 build; source: https://ffmpeg.org/download.html)\nThese programs are started only for a user-requested URL import.\n');
} finally { await rm(temporary, { recursive: true, force: true }); }
