// mk release:build <version> [--local] [--dry-run]
//
// Step 1 of 2 of a release: builds the production APK on EAS (--local: on
// this computer, signed with the production key; see build/local.ts), verifies it,
// uploads it to its versioned R2 key only and installs it on the one
// connected phone. latest.apk is untouched: that is release:promote, after
// the phone check.
//
// The expected versionCode is app.json's when the app pins it there; when
// EAS numbers the builds (no versionCode in app.json, or eas.json
// `appVersionSource: "remote"`), it is the one EAS gave this build
// (`appBuildVersion`), and the APK must carry it.
//
// --dry-run runs every check but only PRINTS the EAS build, the upload and
// the install. With an APK already in dist/, it is verified.
import fs from 'node:fs';
import path from 'node:path';

import { installedVersionCode, listDevices } from '../android.js';
import { fileSize, sha256, verifyApk } from '../apk.js';
import { localBuild } from '../build/local.js';
import { easBuild } from '../eas.js';
import { act, run } from '../exec.js';
import { originHead } from '../http.js';
import { detail, fail, info } from '../log.js';
import { loadEnvLocal, openProject } from '../project.js';
import { APK_TYPE, CACHE_IMMUTABLE, parseVersion, releaseTarget } from './common.js';

export const BUILD_USAGE = 'Usage: mk release:build <version> [--local] [--dry-run]';

export async function releaseBuild(args: string[], dryRun: boolean, local = false): Promise<void> {
  const version = parseVersion(args, BUILD_USAGE);
  const p = openProject({ dryRun, requireDryRunInFixture: true });
  const t = releaseTarget(p, version);

  // --- Preconditions ---------------------------------------------------------
  const tags = run(['git'], ['-C', p.root, 'tag', '--points-at', 'HEAD']).stdout.split('\n');
  if (!tags.includes(`v${version}`)) fail(`HEAD is not tag v${version}. Run: git checkout v${version}`);
  const status = run(['git'], ['-C', p.root, 'status', '--porcelain']);
  if (status.status !== 0 || status.stdout.trim() !== '') {
    fail(`The working tree is not clean (git status). ${local ? 'The build uses' : 'EAS builds'} what is on disk.`);
  }
  loadEnvLocal(p.root);

  const head = originHead(p.tool.curl, t.versionedUrl);
  if (head.status === '200') {
    fail(`${t.versionedKey} already exists on R2. A published version is never overwritten: release a new version.`);
  }
  if (head.status !== '404') fail(`Cannot check ${t.versionedUrl} (HTTP status '${head.status}'). Network?`);
  const vcLabel = t.versionCode !== null ? `versionCode ${t.versionCode}` : 'versionCode from EAS (remote)';
  info(`Preconditions OK: v${version}, ${vcLabel}, clean tree, ${t.versionedKey} is free`);

  // --- Build and download ----------------------------------------------------
  const profile = p.config.easProfiles.release;
  const built = local
    ? (() => {
        const r = localBuild(p, profile, { dest: t.apkPath, verify: false });
        return { downloaded: r.built, appBuildVersion: null };
      })()
    : easBuild(p, profile, t.apkPath);
  const rel = path.relative(p.root, t.apkPath).replace(/\\/g, '/');
  let verify = true;
  if (!built.downloaded) {
    if (fs.existsSync(t.apkPath)) info(`Dry run: verifying the APK already in ${rel}`);
    else {
      info(`Dry run: no ${rel}, so nothing to verify`);
      verify = false;
    }
  }

  // --- Verify ----------------------------------------------------------------
  // app.json's versionCode, else EAS's for this build; on a dry run of a
  // remote app, nothing was built: the APK's own is reported.
  const expected = t.versionCode ?? built.appBuildVersion;
  const expectedFrom = t.versionCode !== null ? 'app.json' : 'the EAS build';
  let versionCode = expected;
  if (verify) {
    const expect = { androidPackage: p.config.androidPackage, version, versionCode: expected, versionCodeFrom: expectedFrom, sha1: t.sha1 };
    const apkVc = verifyApk(t.apkPath, expect, p.tool.aapt, p.tool.apksigner);
    versionCode = apkVc ?? expected;
    info(`${rel}: ${fileSize(t.apkPath)} bytes, sha256 ${sha256(t.apkPath)}`);
  }
  if (versionCode === null && !p.dryRun) {
    fail('Cannot tell the versionCode of this build: EAS gave none and aapt2 is missing. Install the Android build-tools.');
  }
  const vcText = versionCode ?? 'unknown on a dry run';

  // --- Upload (versioned key only) -------------------------------------------
  if (!p.dryRun && originHead(p.tool.curl, t.versionedUrl).status !== '404') {
    fail(`${t.versionedKey} appeared on R2 during the build. Not overwritten.`);
  }
  info(`Uploading ${p.config.r2Bucket}/${t.versionedKey} (latest.apk is not touched)`);
  const upload = act(p.dryRun, p.tool.wrangler, [
    'r2', 'object', 'put', `${p.config.r2Bucket}/${t.versionedKey}`, '--remote',
    '--file', t.apkPath, '--content-type', APK_TYPE, '--cache-control', CACHE_IMMUTABLE,
  ], { cwd: p.root });
  if (upload.status !== 0) fail(`Upload failed: ${t.versionedKey}`);

  // --- Install on the phone --------------------------------------------------
  const { ready } = listDevices(p.tool.adb);
  if (ready.length === 1 && ready[0]) {
    const serial = ready[0];
    info(`Installing on ${serial} (adb install -r keeps the data)`);
    if (act(p.dryRun, p.tool.adb, ['-s', serial, 'install', '-r', t.apkPath]).status !== 0) fail('adb install failed');
    const installed = installedVersionCode(p.tool.adb, serial, p.config.androidPackage);
    info(`Installed versionCode on ${serial}: ${installed ?? 'none'} (expected ${vcText})`);
  } else {
    info(`${ready.length} phone(s) connected by adb: install by hand.`);
    detail(`Copy ${rel} to the phone (or open ${t.versionedUrl} there),`);
    detail('install it OVER the current app (never uninstall), then check');
    detail(`the version in the app: ${version} (${vcText}).`);
  }

  console.log();
  info('Test this build on the phone, then run release:promote');
  detail(`npm run release:promote -- ${version}`);
}
