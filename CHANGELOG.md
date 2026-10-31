# Changelog

All notable changes are listed here ([Keep a Changelog](https://keepachangelog.com/),
[SemVer](https://semver.org/)).

## [0.3.2] - 2026-10-31

What the BookTrack 0.5.0 emulator run of 2026-10-23 taught: 0/11 smoke and
0/34 screenshots, all because of the bench (a JRE as JAVA_HOME, an
emulator starved of memory, a killed run that left everything running).

### Added
- `mk build --local` (and `--dry-run`) checks that `JAVA_HOME` is a
  **JDK 17**: `bin\javac(.exe)` present, version 17 (its `release` file,
  else `javac -version`). Otherwise it stops with the cause (not set,
  missing, a JRE, JDK 21…) and the fix: `setx JAVA_HOME "<JDK 17 found in
  Program Files>"`, or `winget install Microsoft.OpenJDK.17`.
- `qa:device`: **"Process system isn't responding"** (Android's own
  system_server) gets Wait tapped like other apps' ANR dialogs, and is
  counted; past 3 the run stops cleanly with "Emulator saturated" (or
  "Device saturated") on top of the report, device restored.
- `qa:device`: a **known device state** before the flows: night mode
  `no`, `font_scale` 1.0, animations off. Dark batches switch night mode
  back off when done. Animations are saved and restored too; on the
  emulator everything goes back to the known state, never to what a
  killed run left (font_scale 1.3 on 2026-10-23).
- **Software rendering warning**: after each boot mk reads the GLES
  renderer (`dumpsys SurfaceFlinger`); SwiftShader while `gpu` asks for a
  GPU mode is a `SOFTWARE RENDERING` warning in the console (`mk
  emulator`, `qa:device`) and on top of report.html.
- `qa:device --resume <dir> --retry-failed`: the smoke flows that failed
  run again too.
- `qa:device --migration-from <old apk>`: uninstall, install the old APK,
  `<maestroDir>/migration/seed.yaml`, install the APK under test with
  `-r`, `<maestroDir>/migration/verify-upgrade.yaml`, then the usual run.
  Asks first (the uninstall wipes the data); the old APK must be the same
  package and older. A Migration table and badge in the report; a failure
  fails the run.
- A **guard** process for each `qa:device` run (`procs.js guard`,
  detached, nobody's child): when mk is killed it kills what mk started
  (Maestro, adb sessions, the emulator it booted) and Maestro/adb
  processes still on the device; when the shell or terminal that started
  mk dies, mk's children are killed, mk stops at its next checkpoint and
  restores the device, and is killed after 90 s if it is still there.
  `MK_GUARD_LOG` logs what it does.
- A second Ctrl+C stops at once: Maestro, adb and the emulator mk started
  are killed (exit 130).

### Changed
- A failed Gradle build no longer says "Out of memory?" by default: mk
  reads Gradle's output (shown live, its end kept) and names the probable
  cause: no Java compiler (a JRE), wrong JDK version, a real out of
  memory (`Java heap space`, `Metaspace`…), or Gradle's own "What went
  wrong" lines.
- `localBuild()` is async (Gradle's output is teed).
- `qa:device` installs the APK inside the run, so a wrong versionCode now
  also leaves a report saying why it stopped.

## [0.3.1] - 2026-10-23

### Fixed
- `mk keystore:pull` on a French Windows: keytool printed `SHA 1:` (not
  `SHA1:`), so mk found "no SHA-1 fingerprint" and then **deleted the
  keystore folder** it had just written. keytool now runs with
  `-J-Duser.language=en`, and `SHA1:`, `SHA 1:` and `SHA-1:` are all read.
- `mk keystore:pull` never deletes the pulled files: it moves them out of
  the app folder first, then checks them. On any failure (keytool
  missing or failing, wrong key) they stay in `MK_KEYSTORE_DIR` and mk
  stops with the reason, keytool's exit code and error (passwords
  masked).

### Changed
- `mk keystore:pull` moves the files as EAS wrote them:
  `credentials.json` unchanged, the keystore at its relative
  `keystorePath` (`credentials/android/keystore.jks`). A relative
  `keystorePath` is read against `MK_KEYSTORE_DIR` (`mk build --local`
  too); folders pulled by 0.3.0 still work.
- `mk keystore:pull` moves a `credentials.json` an earlier pull left in
  the app folder, without running `eas credentials`.
- keytool is looked for on PATH, then in JAVA_HOME, then in Android
  Studio's JBR; mk says where it looked when there is none.

## [0.3.0] - 2026-10-13

Android builds on this computer, for when the EAS build quota is used up,
signed with the same production key as EAS's.

### Added
- `mk build --local --profile <eas profile>`: `expo prebuild` (clean) with
  the profile's eas.json env (`extends` applied), Gradle `assembleRelease`
  with the production key injected through environment variables into the
  generated, git-ignored `android/` only, then the release APK checks
  (package, versionName, versionCode, certificate SHA-1 = `signingSha1`;
  a failing APK is deleted). Output `dist/<apkName>-<version>-<profile>.apk`.
  Fits a 16 GB PC: stops below 4 GB of free RAM (with a "close Brave"
  hint), Gradle 3 GB / 2 workers / no daemon / Kotlin in-process.
  `package.json` / `app.json` edits by prebuild are undone, `android/` is
  deleted, and no tracked file may change.
- `mk qa:device --local-build`: the `qa` profile built locally, before the
  emulator starts (they never share the RAM).
- `mk release:build <version> --local`: the release APK built locally
  instead of on EAS; every other check and step is unchanged.
- `mk keystore:pull`: runs `eas credentials` (interactive), moves the
  downloaded keystore and passwords at once to `MK_KEYSTORE_DIR`
  (`.env.local`), outside every repository, deletes them from the app
  folder even on failure, and checks the certificate with `keytool`.
- New injectable tools: `MK_EXPO`, `MK_GRADLEW`, `MK_KEYTOOL`.

### Security
- Keystore passwords are never printed, never on a command line, never in
  a file of the app. mk refuses a keystore folder inside a git repository,
  and a pull while `credentials.json` / `*.jks` are not git-ignored.

## [0.2.2] - 2026-10-12

GameTrack numbers its Android builds on EAS (`appVersionSource: "remote"`)
and has no versionCode in app.json, so every mk command stopped at "app.json
has no expo.android.versionCode".

### Changed
- The expected versionCode comes from the build under test when EAS numbers
  the builds: the APK (`aapt2`), checked against EAS's `appBuildVersion`
  when mk ran the build; the latest finished EAS build of the `qa` profile
  with `qa:device --skip-build`; the resumed run's with `--resume`.
  README → versionCode.
- Remote is detected, not configured: no `expo.android.versionCode` in
  app.json, or eas.json `cli.appVersionSource: "remote"` (an app.json value
  is then ignored, with a warning). Apps that pin it in app.json (BookTrack)
  behave as before.
- `results.json` and the report record where the expected versionCode came
  from (`versionCodeFrom`).
- `release:promote` reads the versionCode of the APK it promotes: it must be
  app.json's when the app pins one.

## [0.2.1] - 2026-10-12

The night run of BookTrack 0.3.0 (8/8 smoke, 22/32 screenshots) lost two
whole batches in a row after a cold restart: Maestro could not reach the
emulator, and the report showed Maestro's Cloud box instead of the error.

### Added
- Maestro health check after every emulator boot (`maestro hierarchy`),
  after Maestro processes left on the device are stopped. If it fails, mk
  uninstalls Maestro's driver (`dev.mobile.maestro`,
  `dev.mobile.maestro.test`), which Maestro reinstalls, and checks once
  more. Both outcomes are in the report's notes.
- Batch retry: when 2 or more screenshots of one batch fail, the whole
  batch runs once more (on the emulator, after another cold restart)
  before they are marked failed. A screenshot taken in the first attempt
  is kept if the retry fails.
- Each failed flow's Maestro debug folder (`~/.maestro/tests/<timestamp>`)
  is copied into `<capture folder>/debug/<name>/` (screens:
  `<screen>_<mode>_<lang>_<scale>x`, smoke flows: `smoke-<flow>`) and
  linked from the report, with its `maestro.log`.

### Fixed
- The report shows the real error, the step that failed and its message
  (e.g. `Tap on id: tab-shelves: Element not found: …`), not the last
  lines of the output (Maestro's Cloud box, shown as "?" on Windows). The
  full output, without the box, is under "Maestro output".

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
