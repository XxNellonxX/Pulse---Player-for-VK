# Platform policy

- Pulse uses one shared frontend in `src/` and one shared Rust backend in
  `src-tauri/`. Apply common features and bug fixes to every supported platform:
  Windows 10/11 and macOS 14+. Keep OS-specific integration in platform adapters
  or conditional code; do not maintain separate per-platform copies of shared
  features.
- Android is planned, not implemented. When Android support is added, include it
  in this policy and adapt native capabilities and layout while preserving the
  shared behavior. Do not describe desktop-only code as verified on Android.
- Build platform packages from the same source revision and application version.
  Publish stable Windows `.exe` and macOS Apple Silicon/Intel `.dmg` assets in one
  versioned GitHub Release so the existing `/releases/latest` update check can
  find the appropriate platform package. Keep experimental preview releases
  separate and marked as prereleases. Add Android packages and platform-aware
  update selection when Android support exists.
- Preserve the application identifier and existing profile/data locations across
  updates. OS packaging must not require users to recreate their library or
  reset settings.
- Verify affected shared behavior and platform-specific integrations on each
  supported target, including build compatibility. For changes to login,
  playback, imports, persistence or updates, cover the affected flow on each OS.
  State unavailable checks explicitly: a successful build does not establish
  runtime behavior on a physical device. macOS is currently an unsigned preview
  with successful arm64/x64 builds; physical-Mac login/playback verification is
  still outstanding. Record real results and limits in release documentation.
