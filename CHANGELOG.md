# Changelog

All notable changes are listed here ([Keep a Changelog](https://keepachangelog.com/),
[SemVer](https://semver.org/)).

## [0.2.0] - 2026-10-11

Fits a 16 GB PC: the first full emulator run (BookTrack 0.3.0) ran the host
out of memory during the screenshots.

### Added
- Emulator GPU mode `emulator.gpu`, default `host`, written to `config.ini`
  and passed as `-gpu`. One retry with `swiftshader_indirect` when it does
  not boot. `emulator.headless` (`-no-window`).
- Screenshots in batches of one device setting (mode × language × font
  scale). With `--emulator`, a cold restart (`-no-snapshot`) before each
  batch.
- Memory watchdog: after each capture, if free host RAM is below
  `emulator.minFreeMb` (2048) or the emulator process uses more than
  `emulator.maxEmulatorMb` (6144), mk restarts the emulator, puts the
  batch's settings back and continues.
- Key screens: `screens` entries may be `{ "name", "key": true }`.
- `qa:device --resume <capture folder>`: continues a stopped run. It skips
  the recorded smoke flows and keeps the screenshots taken, installs
  nothing, and restores the settings the first run saved.
- `qa:device --keep-emulator`.
- "Isn't responding" dialogs of other apps (e.g. Pixel Launcher after a
  cold boot) are dismissed with Wait before each flow, and after a boot. A
  screen flow they broke runs once more. The app's own ANR is reported, not
  dismissed.
- `MK_PROCS` tool (`dist/procs.js`): host memory, and stopping leftover
  Maestro and emulator processes.

### Changed
- Smaller default matrix: only key screens get every mode × language ×
  font scale; the others light and dark, first language, scale 1.0. The
  count is printed first.
- `results.json` and `report.html` are rewritten after every flow and
  capture, so a run that is killed still leaves a report. Shots not taken
  are marked "Not captured", with the resume command.
- On exit, mk stops leftover Maestro processes and the emulator it
  started. If `adb emu kill` does not stop the emulator, its processes are
  killed.
- Maestro runs in the capture folder: JVM crash dumps no longer land in
  the app's root.
- SIGTERM and SIGHUP are handled like Ctrl+C.

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
