# mobile-kit

One toolkit for Nachi3D Labs' Expo apps (BookTrack, MangaTrack, GameTrack):
device QA with screenshots, and APK releases to Cloudflare R2. Each app
keeps only a `mobile-kit.config.json` and its Maestro flows.

```
mk qa:device [--apk <path>] [--skip-build] [--yes] [--no-open] [--dry-run]
mk release:build <version> [--dry-run]
mk release:promote <version> [--dry-run]
```

In an app these are npm scripts: `npm run qa:device`, `npm run
release:build -- 0.3.0`, `npm run release:promote -- 0.3.0`.

**Production safety.** `release:build` and `release:promote` write to R2
and purge the Cloudflare cache. They are run by Seàn, or by an agent only
when Seàn explicitly asks in that session, tests included. Every command
accepts `--dry-run`: all checks run, every build, upload, install, purge
and device change is only printed. The test suite (`npm test` here, not in
the apps) runs the CLI with every external command replaced by a fake;
release commands refuse to run on a test fixture without `--dry-run`.

## `mk qa:device`

On the one connected phone or emulator:

1. **APK.** `--apk <path>`, or an EAS build of the `qa` profile (default
   `preview`: `eas build -p android --profile preview --non-interactive
   --wait --json`), downloaded to `dist/<apkName>-<version>-qa.apk`.
   `--skip-build` builds and installs nothing: it tests what is installed.
2. **Device.** Exactly one device on `adb devices`, otherwise it stops with
   help.
3. **Data wipe check.** If a smoke flow uses `clearState` (it wipes the
   app's data), it asks first. `--yes` answers yes. Use an emulator or a
   test phone, not a phone with real data.
4. **Install.** Runs `adb install -r`, which keeps the data. The installed
   versionCode (`dumpsys package`) must equal `app.json`, otherwise it
   stops before testing.
5. **Smoke.** Runs every `<maestroDir>/smoke/*.yaml` in name order, one
   after the other. Files starting with `_` are subflows and are skipped.
6. **Screenshots.** Runs each `screens` flow × light/dark (`cmd uimode
   night`) × each language × each font scale (`settings put system
   font_scale`, default 1.0 and 1.3). Each one is captured with `adb
   exec-out screencap`.
7. **Restore.** Night mode, font scale and app language go back to what
   they were, also after a failure or Ctrl+C.
8. **Report.** Writes `.images/captures/<YYYY-MM-DD>-v<version>/` with the
   PNGs, `logs/`, `results.json` and `report.html`, then opens it (unless
   `--no-open`). The page has a gallery grouped by screen with
   mode/language/scale labels and filters, the Maestro results, and the
   device model, Android version and versionCode.

It exits non-zero if any smoke flow failed or any screenshot is missing.

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
   downloads `dist/<apkName>-<version>.apk`;
2. verifies the package, versionName and versionCode with `aapt2`, and the
   signature and certificate SHA-1 (= `signingSha1`) with `apksigner`;
3. uploads only the versioned key, with `Cache-Control: public,
   max-age=31536000, immutable`;
4. if exactly one phone is on adb, installs with `adb install -r` and
   prints the installed versionCode.

Without Android build-tools it warns clearly and skips only step 2.

**release:promote** refuses unless the versioned object is on R2 with the
same size as `dist/`, and `.env.local` has the Cloudflare settings. It then
asks `Promote <version> to latest? [y/N]`. On `y` it:
1. uploads `<r2Prefix>/latest.apk` with `Cache-Control: no-cache`;
2. purges both URLs through the Cloudflare API. The token goes through a
   private header file, never a command line or the output;
3. checks both public URLs: `200`, the APK content type, the same
   Content-Length, and at most `max-age=60` on `latest.apk`.

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
5. **Maestro.**
   - Download `maestro.zip` from github.com/mobile-dev-inc/maestro/releases
     (latest).
   - Unzip it to `%USERPROFILE%\.maestro`, so you have
     `%USERPROFILE%\.maestro\maestro\bin\maestro.bat`.
   - Add that `bin` folder to PATH and open a new terminal.
   - Check: `maestro --version`.
6. **Expo.** `npx eas-cli login`, or set `EXPO_TOKEN` in `.env.local`.
7. **Cloudflare R2.** `npx wrangler login`, with an account that can write
   to the R2 bucket.
8. **`.env.local`** in each app, git-ignored: copy `.env.local.example`.
   Never commit or paste its values.

   | Name | What |
   |---|---|
   | `CF_ZONE_ID` | dashboard → the domain → Overview → API (right column) → Zone ID |
   | `CF_PURGE_TOKEN` | the cache-purge token below |
   | `EXPO_TOKEN` | optional: expo.dev → Account settings → Access tokens |

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
   `npm install --save-dev github:nachi3d/mobile-kit#v0.1.0`, which pins the
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
     "screens": ["shelf", "copy-detail", "settings"]
   }
   ```

   Optional keys, with their defaults:
   - `"easProfiles": {"qa": "preview", "release": "production"}`;
   - `"languages": {"codes": ["en", "fr"], "method": "app-locale"}`;
   - `"modes": ["light", "dark"]`;
   - `"fontScales": [1.0, 1.3]`.

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
  `MK_MAESTRO`, `MK_AAPT`, `MK_APKSIGNER` and `MK_OPEN`: a command line, or
  a JSON array for paths with spaces.
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
