// Where the EXPECTED versionCode comes from (v0.2.2):
// - local: app.json pins expo.android.versionCode (BookTrack);
// - remote: app.json has none, EAS numbers the builds (GameTrack), so mk
//   reads it from the build: the APK (aapt2), EAS's appBuildVersion, the
//   latest EAS build (--skip-build) or the resumed run.
// Fakes only (test/fixture.ts): aapt prints FAKE_VC, an install sets the
// device's versionCode to FAKE_APK_VC, eas prints FAKE_EAS_VC.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { finishedBuild } from '../dist/eas.js';
import { readAppJson } from '../dist/config.js';
import { renderReport, type QaRun } from '../dist/qa/report.js';
import { APK_BYTES, makeFixture, sideEffects, type Fixture } from './fixture.ts';

const ONE = { FAKE_ADB_DEVICES: 'EMU1' };
const qa = (f: Fixture, args: string[], env: Record<string, string | undefined> = {}) =>
  f.run(['qa:device', ...args], { ...ONE, ...env });
const apkArgs = (f: Fixture) => ['--apk', path.join(f.root, 'dist', 'ExampleApp-0.2.0.apk')];
/** EAS numbers the builds; the next one is 19 (GameTrack's case). */
const REMOTE_19 = { FAKE_VC: '19', FAKE_APK_VC: '19', FAKE_EAS_VC: '19' };
const remote = () => makeFixture({ versionCode: null, easJson: { cli: { appVersionSource: 'remote' } } });

function captureDir(f: Fixture): string {
  const base = path.join(f.root, '.images', 'captures');
  const dirs = fs.readdirSync(base);
  assert.equal(dirs.length, 1);
  return path.join(base, dirs[0]!);
}

function refuses(r: { status: number | null; out: string }, message: string) {
  assert.notEqual(r.status, 0, r.out);
  assert.ok(r.out.includes(message), `expected "${message}" in:\n${r.out}`);
}

describe('app.json versionCode: local or remote', () => {
  it('local: the pinned versionCode', () => {
    const f = makeFixture({ easJson: { cli: { appVersionSource: 'local' } } });
    assert.equal(readAppJson(f.root).versionCode, 16);
  });

  it('remote: none in app.json', () => {
    assert.equal(readAppJson(makeFixture({ versionCode: null }).root).versionCode, null);
  });

  it('remote: one in app.json that eas.json overrides is ignored', () => {
    const f = makeFixture({ easJson: { cli: { appVersionSource: 'remote' } } });
    assert.equal(readAppJson(f.root).versionCode, null);
  });

  it('refuses a versionCode that is not a whole number', () => {
    const f = makeFixture();
    f.write('app.json', JSON.stringify({ expo: { version: '0.2.0', android: { package: 'com.example.app', versionCode: '16' } } }));
    assert.throws(() => readAppJson(f.root), /not a whole number/);
  });

  it("reads EAS's appBuildVersion (a string) from the build JSON", () => {
    const json = (v: unknown) => JSON.stringify([{ status: 'FINISHED', appBuildVersion: v, artifacts: { applicationArchiveUrl: 'u' } }]);
    assert.deepEqual(finishedBuild(json('19')), { url: 'u', appBuildVersion: 19 });
    assert.deepEqual(finishedBuild(json(undefined)), { url: 'u', appBuildVersion: null });
  });
});

describe('mk qa:device, remote versionCode (like GameTrack)', () => {
  it('--apk: expects the APK’s own versionCode, records where it came from', () => {
    const f = remote();
    const r = qa(f, [...apkArgs(f), '--yes', '--no-open'], REMOTE_19);
    assert.equal(r.status, 0, r.out);
    assert.ok(!r.out.includes('has no expo.android.versionCode'));
    assert.ok(r.out.includes('Installed versionCode 19 = the APK'));
    const dir = captureDir(f);
    const results = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
    assert.equal(results.versionCode, 19);
    assert.equal(results.versionCodeFrom, 'the APK');
    assert.ok(fs.readFileSync(path.join(dir, 'report.html'), 'utf8').includes('(versionCode 19, from the APK)'));
  });

  it('--apk: stops before testing when the device did not get that APK', () => {
    const f = remote();
    refuses(qa(f, [...apkArgs(f), '--yes'], { ...REMOTE_19, FAKE_APK_VC: '18' }), 'Installed versionCode is 18, the APK says 19');
    assert.doesNotMatch(f.calls(), /^maestro .* test /m);
  });

  it('--apk without aapt2: stops, it cannot know the expected versionCode', () => {
    const f = remote();
    refuses(qa(f, [...apkArgs(f), '--yes'], { ...REMOTE_19, MK_AAPT: '' }), 'reads it from the APK, and that needs aapt2');
    assert.doesNotMatch(f.calls(), / install /);
  });

  it('EAS build: the APK must carry the versionCode EAS gave the build', () => {
    const f = remote();
    const r = qa(f, ['--yes', '--no-open'], REMOTE_19);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('Installed versionCode 19 = the EAS build'));
    const g = remote();
    refuses(qa(g, ['--yes'], { ...REMOTE_19, FAKE_EAS_VC: '20' }), 'The downloaded APK has versionCode 19, but EAS built 20');
    assert.doesNotMatch(g.calls(), / install /);
  });

  it('--skip-build: expects the latest finished EAS build of the qa profile', () => {
    const f = remote();
    const r = qa(f, ['--skip-build', '--yes', '--no-open'], { FAKE_EAS_VC: '19', FAKE_INSTALLED_VC: '19' });
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('Installed versionCode 19 = the latest EAS preview build'));
    assert.match(f.calls(), /^eas build:list -p android --build-profile preview --status finished --limit 1 --json --non-interactive$/m);
    assert.doesNotMatch(f.calls(), /^eas build /m);
    assert.doesNotMatch(f.calls(), / install /);
  });

  it('--skip-build: stops when the installed build is not the latest one', () => {
    const f = remote();
    refuses(
      qa(f, ['--skip-build', '--yes'], { FAKE_EAS_VC: '19', FAKE_INSTALLED_VC: '18' }),
      'Installed versionCode is 18, the latest EAS preview build says 19',
    );
  });

  it('--skip-build: stops with a clear message when EAS cannot be read', () => {
    refuses(qa(remote(), ['--skip-build', '--yes'], { FAKE_FAIL: 'build:list' }), 'eas build:list failed');
    refuses(qa(remote(), ['--skip-build', '--yes'], { FAKE_EAS_NO_BUILDS: '1' }), 'EAS has no finished Android build of profile preview');
  });

  it('--resume: expects the resumed run’s versionCode', () => {
    const f = remote();
    qa(f, [...apkArgs(f), '--yes', '--no-open'], { ...REMOTE_19, FAKE_FAIL: 'maestro:settings' });
    const dir = captureDir(f);
    const ok = qa(f, ['--resume', dir, '--yes', '--no-open'], REMOTE_19);
    assert.equal(ok.status, 0, ok.out);
    assert.ok(ok.out.includes('Installed versionCode 19 = the resumed run'));
    const results = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ ...results, versionCode: 18 }));
    refuses(qa(f, ['--resume', dir, '--yes'], REMOTE_19), 'Installed versionCode is 19, the resumed run says 18');
  });

  it('--dry-run with nothing built: goes on, the expected versionCode is unknown', () => {
    const f = remote();
    const r = qa(f, ['--dry-run'], REMOTE_19);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('the expected one is unknown'));
    assert.deepEqual(sideEffects(f.calls()), []);
  });

  it('the report of a run that could not know it says so', () => {
    const run = {
      appName: 'A',
      androidPackage: 'com.a',
      version: '1.0.0',
      versionCode: null,
      installedVersionCode: 3,
      apk: 'a.apk',
      device: { serial: 'E', manufacturer: 'G', model: 'P', androidVersion: '15', sdk: 35 },
      startedAt: 's',
      finishedAt: 'f',
      outDir: 'o',
      plan: 'p',
      saved: { night: 'no', fontScale: 'null', appLocales: null },
      smoke: [],
      shots: [],
      notes: [],
    } as QaRun;
    const html = renderReport(run);
    assert.ok(html.includes('(versionCode unknown)'));
    assert.ok(html.includes('Installed versionCode: <b class="bad">3</b>'));
  });
});

describe('mk qa:device, local versionCode (like BookTrack)', () => {
  it('app.json’s versionCode stays the reference, and EAS is never asked', () => {
    const f = makeFixture({ easJson: { cli: { appVersionSource: 'local' } } });
    const r = qa(f, ['--skip-build', '--yes', '--no-open'], { FAKE_INSTALLED_VC: '16', FAKE_EAS_VC: '99' });
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('Installed versionCode 16 = app.json'));
    assert.doesNotMatch(f.calls(), /^eas /m);
  });

  it('an APK with another versionCode than app.json’s still stops the run', () => {
    const f = makeFixture({ easJson: { cli: { appVersionSource: 'local' } } });
    refuses(qa(f, [...apkArgs(f), '--yes'], { FAKE_VC: '19', FAKE_APK_VC: '19' }), 'Installed versionCode is 19, app.json says 16');
  });
});

describe('mk release:*, remote versionCode (dry run)', () => {
  it('release:build: no app.json versionCode needed; the APK’s is verified and reported', () => {
    const f = remote();
    const r = f.run(['release:build', '0.2.0', '--dry-run'], { ...REMOTE_19, FAKE_ADB_DEVICES: 'PHONE1' });
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('versionCode from EAS (remote)'));
    assert.ok(r.out.includes('APK OK: com.example.app 0.2.0 (19)'));
    assert.ok(r.out.includes('(expected 19)'));
    assert.deepEqual(sideEffects(f.calls()), []);
  });

  it('release:build: with no APK on a dry run, the versionCode is unknown, not invented', () => {
    const f = makeFixture({ versionCode: null, withApk: false });
    const r = f.run(['release:build', '0.2.0', '--dry-run'], REMOTE_19);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('(unknown on a dry run)'));
  });

  it('release:promote: reports the APK’s versionCode', () => {
    const f = remote();
    const live = { FAKE_HEAD_STATUS: '200', FAKE_HEAD_LENGTH: String(Buffer.byteLength(APK_BYTES)), FAKE_VC: '19' };
    const r = f.run(['release:promote', '0.2.0', '--dry-run'], live, 'y\n');
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('dist/ExampleApp-0.2.0.apk: versionCode 19 (from EAS)'));
  });
});

describe('mk release:promote, local versionCode', () => {
  it('refuses a dist/ APK whose versionCode is not app.json’s', () => {
    const live = { FAKE_HEAD_STATUS: '200', FAKE_HEAD_LENGTH: String(Buffer.byteLength(APK_BYTES)), FAKE_VC: '14' };
    refuses(makeFixture().run(['release:promote', '0.2.0', '--dry-run'], live, 'y\n'), 'has versionCode 14, app.json says 16');
  });
});
