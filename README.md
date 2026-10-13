# mobile-kit

One toolkit for Nachi3D Labs' Expo apps (BookTrack, MangaTrack, GameTrack):
device QA with screenshots, and APK releases to Cloudflare R2. Each app
keeps only a `mobile-kit.config.json` and its Maestro flows.

```
mk qa:device [--apk <path>] [--skip-build] [--local-build] [--emulator] [--resume <dir>] [--keep-emulator] [--yes] [--no-open] [--dry-run]
mk emulator [--wipe] [--dry-run]
mk release:build <version> [--local] [--dry-run]
mk release:promote <version> [--dry-run]
mk build --local --profile <eas profile> [--dry-run]
mk keystore:pull [--dry-run]
```

In an app these are npm scripts: `npm run qa:device`, `npm run
release:build -- 0.3.0`, `npm run release:promote -- 0.3.0`. The usual QA
run is on the local emulator: `npm run qa:device -- --emulator --yes`.

**Production safety.** `release:build` and `release:promote` write to R2
and purge the Cloudflare cache. They are run by Seàn, or by an agent only
when Seàn explicitly asks in that session, tests included. Every command
accepts `--dry-run`: all checks run, every build, upload, install, purge
and device change is only printed. The test suite (`npm test` here, not in
the apps) runs the CLI with every external command replaced by a fake;
release commands refuse to run on a test fixture without `--dry-run`.

## `mk qa:device`

On the one connected phone or emulator:

1. **Plan.** Prints the number of screenshots first. Screens marked
   `"key": true` get the full matrix: every mode × language × font scale.
   The others get light and dark only, in the first language, at scale
   1.0. Example: `3 key screens × 2 modes × 2 languages × 2 font scales +
   4 screens × 2 modes = 32, in 8 batches`.
2. **APK.** `--apk <path>`, or an EAS build of the `qa` profile (default
   `preview`: `eas build -p android --profile preview --non-interactive
   --wait --json`), downloaded to `dist/<apkName>-<version>-qa.apk`.
   `--skip-build` builds and installs nothing: it tests what is installed.
   `--local-build` builds the `qa` profile on this computer instead, with
   the production key ([Local builds](#local-builds-no-eas-quota)), before
   the emulator starts: `dist/<apkName>-<version>-<profile>.apk`.
3. **Device.** Exactly one device on `adb devices`, otherwise it stops with
   help. With `--emulator`:
   - it refuses while a physical phone is connected (USB or Wi-Fi);
   - otherwise it starts the local emulator like `mk emulator` (or reuses
     it).
4. **Data wipe check.** If a smoke flow uses `clearState` (it wipes the
   app's data), it asks first. `--yes` answers yes. Use an emulator or a
   test phone, not a phone with real data.
5. **Leftovers.** Maestro processes that a killed run left on the device
   are stopped.
6. **Install.** Runs `adb install -r`, which keeps the data. The installed
   versionCode (`dumpsys package`) must equal the expected one, otherwise
   it stops before testing (see [versionCode](#versioncode)).
7. **Smoke.** Runs every `<maestroDir>/smoke/*.yaml` in name order, one
   after the other. Files starting with `_` are subflows and are skipped.
8. **Screenshots, in batches.** One batch per device setting: night mode
   (`cmd uimode night`), font scale (`settings put system font_scale`) and
   language. Each screen is captured with `adb exec-out screencap`. With
   `--emulator`:
   - The emulator is **cold-restarted before each batch**
     (`-no-snapshot`). A booted emulator keeps host memory it never gives
     back.
   - **Watchdog.** After each capture, if free host RAM is below
     `emulator.minFreeMb` (2048), or the emulator process uses more than
     `emulator.maxEmulatorMb` (6144), it restarts the emulator, puts the
     batch's settings back and goes on with the next screen.
   - **Maestro health check after every boot.** Once the emulator has
     booted and is unlocked, mk stops Maestro processes left on it and
     runs `maestro hierarchy`. If that fails, it uninstalls Maestro's
     driver (`dev.mobile.maestro` and `dev.mobile.maestro.test`; Maestro
     reinstalls it on its next run) and checks once more. The report's
     notes say what happened.

   **Batch retry.** If 2 or more screenshots of one batch fail, the whole
   batch runs once more (with `--emulator`, after another cold restart)
   before they are marked failed. That many failures at once mean
   Maestro lost the device, not that the screens are broken. A screenshot
   the first attempt took is kept if the retry fails.
9. **"Isn't responding" dialogs.** Before each flow, mk looks for another
   app's ANR dialog (e.g. "Pixel Launcher isn't responding" after a cold
   boot) and taps its **Wait** button. A screen flow that failed because
   such a dialog appeared runs once more. An ANR of the app under test is
   left alone and reported: it is a finding.
10. **Restore.** Night mode, font scale and app language go back to what
    they were before the first run, also after a failure or Ctrl+C.
11. **Report.** `.images/captures/<YYYY-MM-DD>-v<version>/` holds the PNGs,
    `logs/`, `results.json` and `report.html`.
    - Both files are **rewritten after every flow and capture**, so a run
      that is killed still leaves a report. Screenshots not taken show as
      "Not captured", with the command to resume.
    - The report opens at the end (unless `--no-open`).
    - The page has a gallery grouped by screen with mode/language/scale
      labels and filters, the Maestro results, the notes (restarts,
      dialogs), and the device model, Android version and versionCode.
    - **Failures.** Each failed flow shows the step that failed and its
      error (e.g. `Tap on id: tab-shelves: Element not found: …`), not
      Maestro's Cloud box. Its Maestro debug folder
      (`~/.maestro/tests/<timestamp>`: `maestro.log`, screenshots) is
      copied into `debug/<screen>_<mode>_<lang>_<scale>x/` (smoke flows:
      `debug/smoke-<flow>/`) and linked from the report.
12. **Clean exit.** Maestro processes still running are stopped. If mk
    started or restarted the emulator, it stops it (`--keep-emulator`
    leaves it running). Maestro runs in the capture folder, so JVM crash
    dumps (`hs_err_pid*.log`) land there, never in the app.

It exits non-zero if any smoke flow failed or any screenshot is missing.

**`--resume <capture folder>`** continues a run that stopped (killed,
Ctrl+C, out of memory):
- It builds and installs nothing.
- It skips the smoke flows the first run recorded, keeps its screenshots
  and takes only the missing ones.
- It restores the device settings the **first** run saved, even if the
  killed run left dark mode or 1.3× on.
- It refuses a folder of another version or versionCode (app.json's, or,
  with EAS numbering, the one installed on the device).

Example: `npm run qa:device -- --emulator --yes --resume
.images/captures/2026-10-11-v0.3.0`.

**Languages** (`languages.method`):

- `app-locale` (default) is for apps that follow the system language. It
  sets the Android 13+ per-app language (`cmd locale set-app-locales`) and
  restores it afterwards. On Android 12 and older, screenshots stay in the
  current language and the report says so.
- `flow` is for apps with a language setting. It runs
  `<maestroDir>/<languages.flow>` with `-e LANG=<code>`; `languages.restore`
  (e.g. `system`) is set at the end.
- `deep-link` opens `languages.deepLink` with `{lang}` replaced (`adb
  shell am start -d …`); `languages.restore` works the same way.

## `mk emulator [--wipe]`

The local emulator for QA, idempotent:

1. Creates the AVD if it is missing (`avdmanager create avd`). The
   defaults are `mk-pixel8-api34`, device `pixel_8`, image
   `system-images;android-34;google_apis_playstore;x86_64`.
2. Sets its `config.ini` on every run: `hw.ramSize`, `disk.dataPartition.size`,
   `hw.keyboard=yes`, `hw.gpu.enabled=yes`, `hw.gpu.mode`.
3. Starts it with `-gpu host` (the PC's graphics card), or reuses it if it
   is already running. `--wipe` restarts it with `-wipe-data`.
   - If the GPU mode does not boot (the emulator exits, or is not up
     within 5 minutes), mk retries **once** with `swiftshader_indirect`.
     That is software rendering, which uses much more host memory. The
     config keeps `host`.
   - With `"headless": true` it starts with `-no-window`.
4. Waits for `sys.boot_completed=1`, unlocks the screen, keeps it on and
   sets the window, transition and animator scales to 0 so Maestro runs
   are stable. After a boot it waits 20 s for the system to settle, then
   taps Wait on any "isn't responding" dialog.
5. Prints its adb serial (`emulator-5554`).

A cold boot takes about 1–3 minutes; a reused emulator about 20 s.

Override the defaults with the config's `emulator` key (every key is
optional):

| Key | Default | What |
|---|---|---|
| `avd`, `device`, `image` | `mk-pixel8-api34`, `pixel_8`, API 34 Play x86_64 | the AVD |
| `ramMb` | 4096 | guest RAM. On a 16 GB PC, 3072 leaves room for the rest. |
| `dataPartition` | `"8G"` | data partition |
| `gpu` | `"host"` | `host`, `swiftshader_indirect`, `angle_indirect`, `guest`, `auto` |
| `headless` | `false` | `-no-window` |
| `minFreeMb` | 2048 | qa:device restarts the emulator below this much free host RAM |
| `maxEmulatorMb` | 6144 | …or when the emulator process uses more than this |

**Why these defaults.** On a 16 GB Windows PC, a full screenshot run with
software rendering grew the emulator process past 14 GB, and Maestro's JVM
then crashed for lack of memory. With `-gpu host` it grew far more slowly.
Batches with a cold restart, plus the watchdog, keep it bounded.

## `mk release:build <version>` / `mk release:promote <version>`

A release is two commands and one phone check:

```
npm run release:build -- 0.x.0      # build, verify, upload versioned APK, install on phone
   → test the build on the phone (the one manual step)
npm run release:promote -- 0.x.0    # latest.apk, cache purge, public check
```

**release:build** refuses unless all of these hold:
- HEAD is tag `v<version>`;
- `app.json` says `<version>`;
- the working tree is clean;
- `.env.local` exists;
- `<r2Prefix>/<version>/<apkName>-<version>.apk` is **not** on R2 yet. It
  checks the origin, past the CDN, with a unique `?release-check=` query.
  A published version is never overwritten.

Then it:
1. runs the EAS build of the `release` profile (default `production`) and
   downloads `dist/<apkName>-<version>.apk`. With `--local`, it builds that
   file on this computer instead ([Local builds](#local-builds-no-eas-quota)),
   signed with the same production key;
2. verifies the package, versionName and versionCode with `aapt2`, and the
   signature and certificate SHA-1 (= `signingSha1`) with `apksigner`. The
   versionCode must be app.json's, or, with EAS numbering, the one EAS gave
   this build (see [versionCode](#versioncode));
3. uploads only the versioned key, with `Cache-Control: public,
   max-age=31536000, immutable`;
4. if exactly one phone is on adb, installs with `adb install -r` and
   prints the installed versionCode.

Without Android build-tools it warns clearly and skips only step 2.

**release:promote** also reads the versionCode of `dist/<apkName>-<version>.apk`
(`aapt2`): it must be app.json's when the app pins one; with EAS numbering
it is printed.

### versionCode

mk never guesses the versionCode the device must end up with. Where it
comes from depends on the app, detected automatically (no config key):

- **Local** — `app.json` has `expo.android.versionCode` (BookTrack): that
  number, everywhere.
- **Remote** — no `expo.android.versionCode` in `app.json`, or eas.json
  sets `"cli": {"appVersionSource": "remote"}` (then an app.json value is
  ignored, with a warning: EAS ignores it too). EAS numbers the builds, so
  mk reads it from the build under test:

  | Command | Expected versionCode |
  | --- | --- |
  | `qa:device` (EAS build) | the APK's (`aapt2`), which must equal EAS's `appBuildVersion` |
  | `qa:device --apk` | the APK's (`aapt2`; without build-tools it stops) |
  | `qa:device --skip-build` | the latest **finished** EAS build of the `qa` profile (`eas build:list`, read-only) |
  | `qa:device --resume` | the resumed run's |
  | `release:build` | EAS's `appBuildVersion` of the build; the APK must carry it |

  `results.json` and the report say which source was used. A dry run that
  built nothing does not know it and says so.

**release:promote** refuses unless the versioned object is on R2 with the
same size as `dist/`, and `.env.local` has the Cloudflare settings. It then
asks `Promote <version> to latest? [y/N]`. On `y` it:
1. uploads `<r2Prefix>/latest.apk` with `Cache-Control: no-cache`;
2. purges both URLs through the Cloudflare API. The token goes through a
   private header file, never a command line or the output;
3. checks both public URLs: `200`, the APK content type, the same
   Content-Length, and at most `max-age=60` on `latest.apk`.

## Local builds (no EAS quota)

When the EAS build quota is used up, the same APKs can be built on this
computer, **signed with the production key**: a local `qa` build installs
over the published app (same signature), and a local release build can be
published.

```
mk build --local --profile preview        # → dist/<apkName>-<version>-preview.apk
mk qa:device --emulator --yes --local-build
mk release:build <version> --local        # → dist/<apkName>-<version>.apk, then as usual
```

In an app, add the npm scripts `"keystore:pull": "mk keystore:pull"` and
`"build:local": "mk build --local"` (then `npm run build:local -- --profile
preview`).

EAS stays the default: without `--local` / `--local-build` nothing changes.
Local builds need the app to pin `expo.android.versionCode` in app.json
(an app numbered by EAS cannot be built locally: mk refuses).

### Keystore (once per computer)

The production keystore and its passwords live **outside every
repository**, in a folder named by `MK_KEYSTORE_DIR`:

1. Choose a folder outside any git repository, e.g.
   `D:\Dev\secrets\booktrack`, and add it to the app's `.env.local`
   (git-ignored): `MK_KEYSTORE_DIR=D:\Dev\secrets\booktrack`.
2. In the app folder: `npm run keystore:pull` (`mk keystore:pull`). It
   runs `eas credentials -p android` (interactive, logged in to Expo) and
   prints the answers to choose:
   - build profile → **production**;
   - **credentials.json: Upload/Download credentials between EAS servers
     and your local json** → **Download credentials from EAS to
     credentials.json**;
   - then Go back → Exit.

   EAS writes `credentials.json` and `credentials/android/keystore.jks` in
   the app folder (both git-ignored; mk refuses to start otherwise). mk
   moves them at once to `MK_KEYSTORE_DIR` (`credentials.json` +
   `keystore.jks`), deletes them from the app folder even on failure, and
   checks with `keytool` that the certificate SHA-1 is `signingSha1`. A
   different key (wrong profile) is refused and deleted.
3. Keep a copy of that folder somewhere safe (password manager, encrypted
   drive). The key can never change: sideloaded updates need it.

mk refuses a `MK_KEYSTORE_DIR` inside a git repository, and never
overwrites an existing one (delete it to pull again). Passwords are never
printed, never on a command line, and never in a file of the app: they
reach `keytool` and Gradle through their environment only.

### What `mk build --local` does

1. **Checks**, before anything is generated: the profile exists in
   `eas.json`; app.json pins the versionCode; the keystore is there and its
   certificate is `signingSha1` (`keytool`); `android/` is git-ignored;
   **at least 4 GB of RAM is free** (otherwise it stops: close Brave and
   other browsers, Android Studio, the emulator, other Node/Java
   processes).
2. **Prebuild**: `expo prebuild --platform android --clean --no-install`
   with the profile's `env` from `eas.json` (`extends` applied, as on
   EAS), `NODE_ENV=production`. If prebuild rewrites `package.json` or
   `app.json` (it changes the `android` script), mk puts them back byte
   for byte; afterwards no tracked file may differ (`git status`).
3. **In the generated `android/` only**: release builds are signed by a
   config that reads `MK_SIGNING_*` environment variables (Expo's template
   signs them with the debug key); `gradle.properties` gets
   `-Xmx3g`, `org.gradle.workers.max=2`, no parallel, no daemon, Kotlin
   in-process.
4. **Gradle**: `gradlew assembleRelease --no-daemon --max-workers=2`, the
   key's passwords in its environment.
5. The APK is copied to `dist/`, `android/` is **deleted** (EAS would
   treat a leftover `android/` as a bare project), and the APK is verified
   like a release: package, versionName, versionCode, and certificate
   SHA-1 = `signingSha1`. An APK that fails is deleted.

`--dry-run` runs every check, the key and RAM included, and prints
prebuild and Gradle.

### Windows requirements and tips

- **JDK 17** (Gradle for React Native 0.8x needs 17):
  `winget install Microsoft.OpenJDK.17`, and set `JAVA_HOME` to it (mk
  finds `keytool` there). Check: `java -version`, `"%JAVA_HOME%\bin\keytool" -help`.
- **Android SDK** already set up for the emulator (`ANDROID_HOME`, e.g.
  `D:\Dev\Android\Sdk`): Gradle installs the platform, build-tools, NDK
  and CMake versions it needs on the first build (several GB, on that
  drive). Accept the licences once if Gradle asks:
  `%ANDROID_HOME%\cmdline-tools\latest\bin\sdkmanager --licenses`.
- **`GRADLE_USER_HOME`** on the data drive (e.g. `D:\Dev\gradle`, see
  below): Gradle's caches grow to several GB.
- **Time**: the first build downloads Gradle, the dependencies and the NDK:
  30–45 minutes. Later builds: about 10–20 minutes (a 16 GB PC measured
  13 minutes).
- **RAM**: run it alone. Close Brave and other browsers, Android Studio and
  any emulator; do not run `npm test` at the same time. `qa:device
  --local-build` builds **before** it starts the emulator, so they never
  share the RAM. If Gradle still dies (`OutOfMemoryError`, "The paging
  file is too small"), raise Windows' paging file, or reboot and build
  first thing.

## Setup (Windows, once per computer)

1. **Node 22.18+** and **Git** (Git Bash).
2. **adb (Android SDK Platform-Tools).**
   - With Android Studio: SDK Manager → SDK Tools → *Android SDK
     Platform-Tools*, then add `%LOCALAPPDATA%\Android\Sdk\platform-tools`
     to PATH.
   - Without it: download the platform-tools zip from
     developer.android.com/tools/releases/platform-tools, unzip it (e.g.
     `N:\Tools\platform-tools`) and add that folder to PATH.
   - Check: `adb version`.
3. **Android SDK Build-Tools** (for `aapt2` and `apksigner`, used by
   release:build): SDK Manager → SDK Tools → *Android SDK Build-Tools*.
   They are found through `ANDROID_HOME`, `ANDROID_SDK_ROOT` or
   `%LOCALAPPDATA%\Android\Sdk`.
4. **Java 17+** (Maestro needs it): `winget install Microsoft.OpenJDK.17`.
   Check: `java -version`.
5. **Android emulator** (for `--emulator`; skip it if you only test on a
   phone). From the Android SDK folder (`%LOCALAPPDATA%\Android\Sdk`):
   - **cmdline-tools.**
     - Download `commandlinetools-win-*_latest.zip` from
       developer.android.com/studio#command-line-tools-only.
     - Unzip it so you get `cmdline-tools\latest\bin\avdmanager.bat`.
   - **Packages.** Recent cmdline-tools replace `sdkmanager` with the
     `android` CLI. Its package names use `/` instead of `;`:

     ```
     cmdline-tools\latest\bin\android.exe --no-metrics sdk install emulator platform-tools
     cmdline-tools\latest\bin\android.exe --no-metrics sdk install system-images/android-34/google_apis_playstore/x86_64
     ```
   - **Acceleration.** `emulator\emulator.exe -accel-check` must say
     "WHPX … is installed and usable".
     - If not, enable **Windows Hypervisor Platform**: Windows Features,
       or as admin
       `Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform`,
       then reboot.
     - If it is still not usable, turn on CPU virtualization (Intel VT-x /
       AMD-V) in the BIOS.
   - **First start.** `mk emulator` creates the AVD on its first run.
6. **Maestro.**
   - Download `maestro.zip` from github.com/mobile-dev-inc/maestro/releases
     (latest).
   - Unzip it to `%USERPROFILE%\.maestro`, so you have
     `%USERPROFILE%\.maestro\maestro\bin\maestro.bat`.
   - Add that `bin` folder to PATH and open a new terminal.
   - Optional: set the user environment variable
     `MAESTRO_CLI_NO_ANALYTICS=1` to turn off Maestro's anonymous
     analytics.
   - Check: `maestro --version`.
7. **Expo.** `npx eas-cli login`, or set `EXPO_TOKEN` in `.env.local`.
8. **Cloudflare R2.** `npx wrangler login`, with an account that can write
   to the R2 bucket.
9. **`.env.local`** in each app, git-ignored: copy `.env.local.example`.
   Never commit or paste its values.

   | Name | What |
   |---|---|
   | `CF_ZONE_ID` | dashboard → the domain → Overview → API (right column) → Zone ID |
   | `CF_PURGE_TOKEN` | the cache-purge token below |
   | `EXPO_TOKEN` | optional: expo.dev → Account settings → Access tokens |
   | `MK_KEYSTORE_DIR` | local builds: the production keystore folder, outside every repository ([Keystore](#keystore-once-per-computer)) |

### Keep the SDK, AVDs and caches on a drive with space

The tools below take 15 GB or more, mostly the system image and the AVD's
data. On a small system drive, keep them on a data drive, e.g. `D:\Dev`,
and point the tools there with **user** environment variables: System
Properties → Environment Variables, or
`[Environment]::SetEnvironmentVariable('NAME', 'value', 'User')`. Avoid
`setx` for PATH, which truncates at 1024 characters.

| What | Variable or setting | Example |
|---|---|---|
| Android SDK (platform-tools, emulator, build-tools, system images) | `ANDROID_HOME`, `ANDROID_SDK_ROOT` | `D:\Dev\Android\Sdk` |
| AVDs (the emulator's disks, ~7 GB each) | `ANDROID_AVD_HOME` | `D:\Dev\Android\avd` |
| Gradle (local Android builds) | `GRADLE_USER_HOME` | `D:\Dev\gradle` |
| npm cache (npx included) | `npm config set cache D:\Dev\npm-cache` | `D:\Dev\npm-cache` |
| Maestro | PATH entry `…\maestro\bin`; `MAESTRO_CLI_NO_ANALYTICS=1` | `D:\Dev\maestro` |
| Playwright browsers | `PLAYWRIGHT_BROWSERS_PATH` | `D:\Dev\ms-playwright` |
| Temp files (Jest cache, Metro, EAS uploads, test fixtures) | `TEMP`, `TMP` | `D:\Dev\Temp` |

PATH (user) entries for the SDK:
- `%ANDROID_HOME%\platform-tools`
- `%ANDROID_HOME%\emulator`
- `%ANDROID_HOME%\cmdline-tools\latest\bin`
- `%ANDROID_HOME%\build-tools\<version>`

Keep **one** adb on PATH: two adb versions keep restarting each other's
server.

**Moving an existing AVD.**
1. Copy the `avd` folder to its new place.
2. Set `ANDROID_AVD_HOME`.
3. Edit `<name>.ini` there so that `path=` is the new `<name>.avd` folder.
4. Check: `emulator -list-avds`.

mk finds the SDK through `ANDROID_HOME` and the AVDs through
`ANDROID_AVD_HOME`. Open a new terminal after changing a variable.

### Cloudflare cache-purge token

Dashboard → My Profile → **API Tokens** → Create Token → **Create Custom
Token**:

- Name: `release cache purge`.
- Permissions: **Zone → Cache Purge → Purge**, and nothing else.
- Zone Resources: **Include → Specific zone → the downloads domain**.

Copy it once into `.env.local` as `CF_PURGE_TOKEN`. It cannot write to R2
or change DNS; R2 uploads use your `wrangler login`.

Check it without printing it:
`curl -s -H "Authorization: Bearer $(grep ^CF_PURGE_TOKEN= .env.local | cut -d= -f2-)" https://api.cloudflare.com/client/v4/user/tokens/verify`
→ `"status":"active"`.

### Cloudflare cache rules (once per downloads domain)

The downloads host is a **custom domain** of the R2 bucket (R2 → bucket →
Settings → Custom Domains), not the `r2.dev` URL. Caching is set with
**Cache Rules on that host only**, not with zone-wide settings: leave
Caching → Configuration → Browser Cache TTL as it is for the rest of the
domain.

Caching → **Cache Rules** → Create rule, in this order (a later rule wins
where both match):

1. **`downloads: respect origin`**
   - If: *Hostname equals `downloads.example.com`*.
   - Then:
     - Cache eligibility: **Eligible for cache**;
     - Edge TTL: **Use cache-control header if present, bypass cache if not**;
     - Browser TTL: **Respect origin TTL**.
   - Versioned APKs (`max-age=31536000, immutable`) stay cached; nothing
     overrides the headers the release commands set.
2. **`downloads: latest.apk never cached`**
   - If: *Hostname equals `downloads.example.com`* **and** *URI Path ends
     with `/latest.apk`*.
   - Then: Cache eligibility **Bypass cache**; Browser TTL **Respect origin
     TTL** (`no-cache`).

Do not add "ignore query string" to the cache key on this host: the
release commands read R2 itself through a unique `?release-check=` query.

**Check after setup:** `curl -sI https://<host>/<prefix>/latest.apk` should
show `cache-control: no-cache` and `cf-cache-status: BYPASS` or `DYNAMIC`.
`release:promote` fails its last check if `latest.apk` comes back with a
`max-age` above 60 s.

If the purge fails, purge by hand: dashboard → the domain → Caching →
Configuration → Purge Cache → Custom Purge → both URLs.

## Adopting it in an app

1. **Install.**
   `npm install --save-dev github:nachi3d/mobile-kit#v0.2.0`, which pins the
   tag. `dist/` is committed, so there is no build step.
2. **`mobile-kit.config.json`** at the app root:

   ```json
   {
     "appName": "BookTrack",
     "androidPackage": "com.nachi3d.booktrack",
     "apkName": "BookTrack",
     "r2Bucket": "nachi3d-downloads",
     "r2Prefix": "booktrack",
     "downloadsHost": "downloads.nachi3dlabs.com",
     "signingSha1": "A9:72:57:A7:C0:D5:58:E2:96:03:18:FA:D7:AB:87:69:A3:52:0B:DF",
     "maestroDir": ".maestro",
     "screens": [{ "name": "shelf", "key": true }, "copy-detail", "settings"]
   }
   ```

   A `screens` entry is a flow name, or `{ "name", "key": true }` for a
   key screen (full matrix, see `mk qa:device` → Plan).

   Optional keys, with their defaults:
   - `"easProfiles": {"qa": "preview", "release": "production"}`;
   - `"languages": {"codes": ["en", "fr"], "method": "app-locale"}`;
   - `"modes": ["light", "dark"]`;
   - `"fontScales": [1.0, 1.3]`;
   - `"emulator": {…}` (see `mk emulator`).

   `androidPackage` must match `app.json`.

   `signingSha1` comes from `npx eas-cli credentials -p android` →
   production → Keystore ("SHA1 Fingerprint"). It is also the SHA-1 of the
   app's Google Android OAuth client.
3. **npm scripts:**

   ```json
   "qa:device": "mk qa:device",
   "release:build": "mk release:build",
   "release:promote": "mk release:promote"
   ```
4. **Ignored files.** `.gitignore` needs `dist/`, `*.apk`, `.env*.local`
   and `.images/`. Commit `.env.local.example` (the three names above,
   empty).
5. **`eas.json`** has an APK `preview` profile (`"distribution":
   "internal", "android": {"buildType": "apk"}`) and an APK `production`
   profile.
6. **Maestro flows** in `<maestroDir>`:
   - `smoke/NN-name.yaml` run in name order and share state. The first one
     may `launchApp: {clearState: true}`.
   - `screens/<name>.yaml`, one per `screens` entry:
     - start with `- launchApp: {appId: ${APP_ID}, stopApp: true}` (no
       clearState);
     - navigate to the screen;
     - end with `- waitForAnimationToEnd`;
     - no `takeScreenshot`: mk captures the screen.
   - Every flow starts with `appId: ${APP_ID}`; mk passes `-e
     APP_ID=<androidPackage>`.
   - Match elements by `id:` (testID), never by text: the flows run in
     every language.
7. **testIDs** on everything the flows tap or assert:
   - React Navigation tabs: `tabBarButtonTestID`.
   - **Expo Router** (MangaTrack): in `app/(tabs)/_layout.tsx`, give each
     `<Tabs.Screen>` `options={{ tabBarButtonTestID: 'tab-<name>' }}`.
     Screens are routes, so a flow can also open one directly when the
     app has a scheme:
     `- openLink: <scheme>://<route>`.
   - React Native puts `testID` into the Android resource-id, which
     Maestro's `id:` matches.
8. **A render test** asserting the testIDs the flows rely on, so a refactor
   that drops one fails the app's `npm test` instead of the next device
   run.
9. **Docs.** Each app's TESTING.md marks which SMOKE cases are automated by
   which flow. Its RELEASE.md points here.

## What stays manual

- **Looking at the screenshots** in `report.html`: layout, clipping at 1.3×,
  dark mode, French text length. mk only proves that the screens open.
- **Google sign-in and two-device Drive sync**, once per release, on real
  devices with a real account.
- **The phone check** between `release:build` and `release:promote`.
- Anything the smoke flows do not cover (see each app's TESTING.md).

## Developing mobile-kit

```bash
npm install
npm test          # builds, then runs test/*.test.ts (fakes only, ~90 s)
npm run typecheck
```

- Fakes are injected through `MK_EAS`, `MK_WRANGLER`, `MK_CURL`, `MK_ADB`,
  `MK_MAESTRO`, `MK_AAPT`, `MK_APKSIGNER`, `MK_OPEN`, `MK_EMULATOR`,
  `MK_AVDMANAGER`, `MK_PROCS`, `MK_EXPO`, `MK_GRADLEW` and `MK_KEYTOOL`: a
  command line, or a JSON array for paths with spaces. The fixture's
  keystore is a fake file in a temporary folder outside the fixture repo.
  - `MK_PROCS` (default `node dist/procs.js`) reads host memory and stops
    leftover Maestro and emulator processes.
- Timings for tests: `MK_POLL_MS`, `MK_BOOT_TIMEOUT_MS`,
  `MK_STOP_TIMEOUT_MS`, `MK_SETTLE_MS`.
- `MK_ROOT` points at a test fixture. It requires every command injected,
  and `--dry-run` for release commands.
- Never use PATH stubs.

**Releasing a new version.**
1. Bump `package.json` and run `npm test`.
2. Run `npm run check:dist`; `dist/` must be committed and current.
3. Merge into `dev` with `--no-ff`.
4. Tag `vX.Y.Z` and push the tag.
5. In each app, bump the `#vX.Y.Z` of the devDependency.

`main` follows `dev` after approval.
