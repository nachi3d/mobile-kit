# Changelog

All notable changes are listed here ([Keep a Changelog](https://keepachangelog.com/),
[SemVer](https://semver.org/)).

## [0.1.1] - 2026-10-11

### Added
- `mk emulator [--wipe]`: creates the AVD if missing (default
  mk-pixel8-api34, Pixel 8, API 34 Google Play x86_64), sets RAM 4096M,
  data 8G and the hardware keyboard, starts it headed (or reuses it), waits
  for boot, unlocks the screen and turns animations off; prints the serial.
- `mk qa:device --emulator`: starts the emulator automatically and refuses
  to run while a physical phone is connected.
- Optional `emulator` config key; `MK_EMULATOR` / `MK_AVDMANAGER` injection.
- README: command-line emulator setup (cmdline-tools, `android sdk
  install`, acceleration check) and the Maestro analytics opt-out.

## [0.1.0] - 2026-10-11

### Added
- `mk qa:device`: EAS preview build (or `--apk`, `--skip-build`), one-device
  check, `adb install -r`, installed versionCode = app.json, Maestro smoke
  flows, screenshot matrix (screens × light/dark × languages × font scales)
  with device settings restored even on failure or Ctrl+C, and an HTML
  report in `.images/captures/<date>-v<version>/`.
- `mk release:build` / `mk release:promote`: ported from BookTrack's
  `scripts/release/` and driven by `mobile-kit.config.json`. Covers the
  preconditions, APK verification including the certificate SHA-1, the
  versioned upload, the y/N promote, `latest.apk` with a Cloudflare API
  purge, and public checks.
- `--dry-run` on every command; external commands injected through `MK_*`
  environment variables; a test suite with fakes only.
