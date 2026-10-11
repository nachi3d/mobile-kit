// mk qa:device against a fixture app and a FAKE adb / maestro / eas
// (test/fakes/fake.mjs): no real device is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeFixture, sideEffects, type Fixture } from './fixture.ts';

const ONE = { FAKE_ADB_DEVICES: 'EMU1' };
const qa = (f: Fixture, args: string[], env: Record<string, string | undefined> = {}, input = '') =>
  f.run(['qa:device', ...args], { ...ONE, ...env }, input);

const apkArgs = (f: Fixture) => ['--apk', path.join(f.root, 'dist', 'ExampleApp-0.2.0.apk')];

/** The device settings and installed versionCode, without the emulator flag. */
const settings = (f: Fixture) => {
  const { emulator: _emulator, ...rest } = f.state();
  return rest;
};

function captureDir(f: Fixture): string {
  const base = path.join(f.root, '.images', 'captures');
  const dirs = fs.readdirSync(base);
  assert.equal(dirs.length, 1);
  return path.join(base, dirs[0]!);
}

describe('mk qa:device: device and options', () => {
  it('stops with help without exactly one device', () => {
    const f = makeFixture();
    const none = qa(f, ['--dry-run'], { FAKE_ADB_DEVICES: '', FAKE_ADB_UNAUTHORIZED: 'R5CX' });
    assert.notEqual(none.status, 0);
    assert.ok(none.out.includes('0 device(s) ready on adb, need exactly 1'));
    assert.ok(none.out.includes('Not ready: R5CX (unauthorized)'));
    assert.ok(none.out.includes('USB debugging'));
    const two = qa(f, ['--dry-run'], { FAKE_ADB_DEVICES: 'A B' });
    assert.ok(two.out.includes('2 device(s) ready'));
    assert.deepEqual(sideEffects(f.calls()), []);
  });

  it('refuses unknown options and a missing --apk path', () => {
    const f = makeFixture();
    assert.ok(qa(f, ['--fast']).out.includes('Unknown option: --fast'));
    assert.ok(qa(f, ['--apk']).out.includes('--apk needs a path'));
    assert.ok(qa(f, ['--apk', 'nope.apk']).out.includes('Not an APK'));
  });

  it('refuses a config screen without its flow', () => {
    const f = makeFixture({ config: { screens: ['home', 'people'] } });
    const r = qa(f, ['--dry-run']);
    assert.notEqual(r.status, 0);
    assert.ok(r.out.includes('Screen flow missing: .maestro/screens/people.yaml'));
  });
});

describe('mk qa:device --dry-run', () => {
  it('prints the build, install, every flow and setting change; executes none', () => {
    const f = makeFixture();
    const r = qa(f, ['--dry-run']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /not executed\].*eas build -p android --profile preview --non-interactive --wait --json/);
    assert.match(r.out, /not executed\].*adb -s EMU1 install -r .*ExampleApp-0\.2\.0-qa\.apk/);
    assert.ok(r.out.includes('would ask: 01-onboarding.yaml CLEAR ExampleApp'));
    assert.ok(r.out.includes('a real run stops here'));
    // Smoke flows in name order, the _helper subflow skipped.
    const smoke = [...r.out.matchAll(/maestro --device EMU1 test \S+smoke[\\/]([\w.-]+\.yaml)/g)].map((m) => m[1]);
    assert.deepEqual(smoke, ['01-onboarding.yaml', '02-add.yaml']);
    // 2 screens × 2 modes × 2 languages × 2 scales.
    assert.ok(r.out.includes('= 16'));
    assert.equal([...r.out.matchAll(/screencap -p > /g)].length, 16);
    assert.ok(r.out.includes('uimode night yes'));
    assert.ok(r.out.includes('settings put system font_scale 1.3'));
    assert.ok(r.out.includes('set-app-locales com.example.app --user current --locales fr'));
    // Restored to what was read: night "no", font_scale never set, app language = system.
    const restore = r.out.slice(r.out.indexOf('Restoring the device settings'));
    assert.ok(restore.includes('uimode night no'));
    assert.ok(restore.includes('settings delete system font_scale'));
    assert.ok(restore.includes(`--locales '""'`));
    assert.ok(r.out.includes('Dry run: no report written'));
    assert.deepEqual(sideEffects(f.calls()), []);
    assert.ok(!fs.existsSync(path.join(f.root, '.images')));
  });

  it('uses only the current language on Android 12 and older', () => {
    const r = qa(makeFixture(), ['--dry-run'], { FAKE_SDK: '31' });
    assert.ok(r.out.includes('Per-app language needs Android 13+'));
    assert.ok(r.out.includes('= 8'));
    assert.ok(!r.out.includes('set-app-locales'));
  });

  it('switches the language with a flow when the config says so', () => {
    const f = makeFixture({ config: { languages: { codes: ['en', 'ar'], method: 'flow', flow: 'set-language.yaml', restore: 'system' } } });
    f.write('.maestro/set-language.yaml', 'appId: ${APP_ID}\n---\n- launchApp\n');
    const r = qa(f, ['--dry-run']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /set-language\.yaml'? -e APP_ID=com\.example\.app -e LANG=ar/);
    assert.match(r.out, /set-language\.yaml'? -e APP_ID=com\.example\.app -e LANG=system/);
    assert.deepEqual(sideEffects(f.calls()), []);
  });
});

describe('mk qa:device with a fake device', () => {
  it('installs, checks the versionCode, runs everything, restores the device and writes the report', () => {
    const f = makeFixture();
    const r = qa(f, [...apkArgs(f), '--yes'], { FAKE_NIGHT: 'auto', FAKE_FONT_SCALE: '1.15', FAKE_LOCALES: 'en-GB' });
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('Installed versionCode 16 = app.json'));
    assert.deepEqual(settings(f), { night: 'auto', font_scale: '1.15', locales: 'en-GB', versionCode: '16' });

    const dir = captureDir(f);
    assert.match(path.basename(dir), /^\d{4}-\d{2}-\d{2}-v0\.2\.0$/);
    const pngs = fs.readdirSync(dir).filter((n) => n.endsWith('.png'));
    assert.equal(pngs.length, 16);
    assert.ok(pngs.includes('home_dark_fr_1.3x.png'));
    const html = fs.readFileSync(path.join(dir, 'report.html'), 'utf8');
    assert.ok(html.includes('Google Pixel Test · Android 15 (API 35) · EMU1'));
    assert.ok(html.includes('Installed versionCode: <b class="good">16</b>'));
    assert.ok(html.includes('Smoke: 2/2 passed'));
    assert.ok(html.includes('Screenshots: 16/16'));
    assert.ok(html.includes('<h2>settings</h2>'));
    assert.ok(html.includes('dark · fr · 1.3×'));
    const results = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
    assert.equal(results.shots.length, 16);
    assert.match(f.calls(), /^open .*report\.html$/m);
  });

  it('asks before smoke flows that clear the app data; no answer stops before installing', () => {
    const f = makeFixture();
    const r = qa(f, apkArgs(f), {}, '');
    assert.notEqual(r.status, 0);
    assert.ok(r.out.includes("CLEAR ExampleApp's data on Pixel Test (EMU1). Continue? [y/N]"));
    assert.ok(r.out.includes('Stopped: nothing installed or changed.'));
    assert.deepEqual(sideEffects(f.calls()), []);
  });

  it('stops before testing when the installed versionCode is not app.json’s', () => {
    const f = makeFixture();
    const r = qa(f, [...apkArgs(f), '--yes'], { FAKE_APK_VC: '15' });
    assert.notEqual(r.status, 0);
    assert.ok(r.out.includes('Installed versionCode is 15, app.json says 16'));
    assert.doesNotMatch(f.calls(), /^maestro /m);
  });

  it('--skip-build tests what is installed, without installing', () => {
    const f = makeFixture();
    const r = qa(f, ['--skip-build', '--yes', '--no-open'], { FAKE_INSTALLED_VC: '16' });
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(f.calls(), / install /);
    assert.doesNotMatch(f.calls(), /^open /m);
  });

  it('reports failed flows and missing screenshots, exits non-zero, still restores the device', () => {
    const f = makeFixture();
    const r = qa(f, [...apkArgs(f), '--yes', '--no-open'], { FAKE_FAIL: 'maestro:02-add,maestro:settings' });
    assert.notEqual(r.status, 0);
    assert.ok(r.out.includes('1 smoke flow(s) failed, 8 screenshot(s) missing'));
    assert.deepEqual(settings(f), { night: 'no', font_scale: 'null', locales: '', versionCode: '16' });
    const html = fs.readFileSync(path.join(captureDir(f), 'report.html'), 'utf8');
    assert.ok(html.includes('Smoke: 1/2 passed'));
    assert.ok(html.includes('Assertion is false: id: missing-thing is visible'));
    assert.ok(html.includes('No screenshot'));
  });

  it('restores the device when a setting change fails mid-matrix', () => {
    const f = makeFixture();
    const r = qa(f, [...apkArgs(f), '--yes', '--no-open'], { FAKE_FAIL: 'screencap', FAKE_NIGHT: 'yes', FAKE_LOCALES: 'fr-FR' });
    assert.notEqual(r.status, 0);
    assert.ok(r.out.includes('16 screenshot(s) missing'));
    assert.deepEqual(settings(f), { night: 'yes', font_scale: 'null', locales: 'fr-FR', versionCode: '16' });
  });

  it('builds with the qa EAS profile and downloads the APK when no --apk is given', () => {
    const f = makeFixture();
    const r = qa(f, ['--yes', '--no-open']);
    assert.equal(r.status, 0, r.out);
    assert.match(f.calls(), /^eas build -p android --profile preview --non-interactive --wait --json$/m);
    assert.match(f.calls(), /^curl -fsSL -o .*ExampleApp-0\.2\.0-qa\.apk https:\/\/expo\.invalid\/build\.apk$/m);
    assert.ok(fs.existsSync(path.join(f.root, 'dist', 'ExampleApp-0.2.0-qa.apk')));
  });

  it('a second run the same day gets its own folder', () => {
    const f = makeFixture();
    qa(f, [...apkArgs(f), '--yes', '--no-open']);
    qa(f, [...apkArgs(f), '--yes', '--no-open']);
    const dirs = fs.readdirSync(path.join(f.root, '.images', 'captures')).sort();
    assert.equal(dirs.length, 2);
    assert.match(dirs[1]!, /-v0\.2\.0-2$/);
  });
});
