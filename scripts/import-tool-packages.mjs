// Release artifacts are pinned by digest. Never resolve a mutable "latest"
// download when preparing a distributable application.
const release = (repository, version, asset, sha, executable = asset, extra = {}) => ({
  name: asset, url: `https://github.com/${repository}/releases/download/${version}/${asset}`, sha, executable, ...extra,
});

export function importToolPackages(platform, arch) {
  if (platform === 'win32' && arch === 'x64') return [
    release('yt-dlp/yt-dlp', '2026.08.19', 'yt-dlp.exe', '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a'),
    { name: 'ffmpeg.zip', url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', sha: '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba', executable: 'ffmpeg.exe', outputs: ['ffmpeg.exe', 'ffprobe.exe'] },
    release('denoland/deno', 'v2.9.7', 'deno-x86_64-pc-windows-msvc.zip', 'a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238', 'deno.exe'),
  ];
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) {
    const arm = arch === 'arm64', suffix = `darwin-${arch}`;
    return [
      release('yt-dlp/yt-dlp', '2026.08.19', 'yt-dlp_macos', '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202', 'yt-dlp'),
      release('eugeneware/ffmpeg-static', 'b6.1.1', `ffmpeg-${suffix}`, arm ? 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584' : 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894', 'ffmpeg'),
      release('eugeneware/ffmpeg-static', 'b6.1.1', `ffprobe-${suffix}`, arm ? 'bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64' : 'fa3add0ce901f7241abe0dfc0155d958fc834aca3f8ce61f87cc712ae669c1e0', 'ffprobe'),
      release('denoland/deno', 'v2.9.7', `deno-${arm ? 'aarch64' : 'x86_64'}-apple-darwin.zip`, arm ? '5cd46d6268f6f78f5d88bdc7159d20bd44cdaa4b3303474839f87ec6fe7ae25c' : '95daaff11c116a52ad54785e7914c8e9c9cdcaba793c5ed929c74ca2d8e6259a', 'deno'),
      release('eugeneware/ffmpeg-static', 'b6.1.1', `${suffix}.LICENSE`, arm ? 'cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2' : '2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af', `${suffix}.LICENSE`, { notice: true }),
      release('eugeneware/ffmpeg-static', 'b6.1.1', `${suffix}.README`, arm ? '05ba4b92c96605434b1aaae3eedf5a2c280c9607bf78ffca9a5b536d9af2dc6a' : 'e88a0325f8e5b75210355e37341824f074d3cd82def2125be54c914b62848a36', `${suffix}.README`, { notice: true }),
    ];
  }
  throw new Error(`URL import tools are not packaged for ${platform}/${arch}. Build on Windows x64 or macOS arm64/x64.`);
}

export function importToolSources(platform, arch, packages) {
  return [
    `Pulse URL import tools for ${platform}/${arch}. Started only during a requested URL import.`,
    'yt-dlp 2026.08.19: https://github.com/yt-dlp/yt-dlp (Unlicense; official packaged third-party notices apply)',
    'Deno 2.9.7: https://github.com/denoland/deno (MIT)',
    platform === 'darwin'
      ? 'FFmpeg/FFprobe 6.1.1 static macOS builds: https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1 (GPL; LICENSE and source/build README included; upstream https://ffmpeg.org/download.html)'
      : 'FFmpeg Windows essentials by gyan.dev: https://www.gyan.dev/ffmpeg/builds/ (GPLv3; upstream sources https://ffmpeg.org/download.html)',
    ...packages.map(item => `${item.executable}: ${item.url} SHA-256 ${item.sha}`), '',
  ].join('\n');
}
