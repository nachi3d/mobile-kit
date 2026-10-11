import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { waitButtonCentre } from '../dist/android.js';
import { loadConfig, normalizeSha1, validateConfig } from '../dist/config.js';
import { parseCommand } from '../dist/exec.js';
import { memoryPressure } from '../dist/host.js';
import { buildPlan } from '../dist/qa/plan.js';
import { renderReport, type QaRun } from '../dist/qa/report.js';
import { makeFixture } from './fixture.ts';
import { BASE_CONFIG } from './fixture.ts';

describe('config', () => {
  it('accepts the base config and optional keys', () => {
    assert.deepEqual(validateConfig(BASE_CONFIG), []);
    assert.deepEqual(
      validateConfig({
        ...BASE_CONFIG,
        easProfiles: { qa: 'preview', release: 'production' },
        languages: { codes: ['en'], method: 'deep-link', deepLink: 'app://lang/{lang}' },
        modes: ['dark'],
        fontScales: [1, 1.3],
      }),
      [],
    );
  });

  it('names each missing or wrong key', () => {
    const errors = validateConfig({ ...BASE_CONFIG, appName: '', r2Prefix: '/x/', fontScales: [3], modes: ['sepia'] });
    assert.equal(errors.length, 4);
    assert.ok(validateConfig([]).includes('must be a JSON object'));
    assert.ok(validateConfig({ ...BASE_CONFIG, languages: { codes: ['en'], method: 'flow' } })[0]?.includes('needs "languages.flow"'));
  });

  it('accepts screens as names or { name, key }, and the emulator GPU and memory limits', () => {
    assert.deepEqual(
      validateConfig({
        ...BASE_CONFIG,
        screens: ['settings', { name: 'home', key: true }],
        emulator: { gpu: 'host', headless: true, minFreeMb: 2048, maxEmulatorMb: 6144 },
      }),
      [],
    );
    assert.equal(validateConfig({ ...BASE_CONFIG, screens: [{ name: 'Home' }] }).length, 1);
    assert.equal(validateConfig({ ...BASE_CONFIG, screens: [{ name: 'home', key: 'yes' }] }).length, 1);
    assert.equal(validateConfig({ ...BASE_CONFIG, emulator: { gpu: 'nvidia' } }).length, 1);
    assert.equal(validateConfig({ ...BASE_CONFIG, emulator: { maxEmulatorMb: 10 } }).length, 1);
  });

  it('defaults: GPU host, a window, restart below 2 GB free or above 6 GB; screens not key', () => {
    const f = makeFixture({ config: { screens: ['settings', { name: 'home', key: true }] } });
    const c = loadConfig(f.root);
    assert.deepEqual(c.screens, [
      { name: 'settings', key: false },
      { name: 'home', key: true },
    ]);
    assert.equal(c.emulator.gpu, 'host');
    assert.equal(c.emulator.headless, false);
    assert.equal(c.emulator.minFreeMb, 2048);
    assert.equal(c.emulator.maxEmulatorMb, 6144);
  });

  it('normalizes the certificate SHA-1', () => {
    assert.equal(normalizeSha1('A9:72:57:A7:C0:D5:58:E2:96:03:18:FA:D7:AB:87:69:A3:52:0B:DF'), 'a97257a7c0d558e2960318fad7ab8769a3520bdf');
    assert.equal(normalizeSha1('a97257a7c0d558e2960318fad7ab8769a3520bdf'), 'a97257a7c0d558e2960318fad7ab8769a3520bdf');
    assert.equal(normalizeSha1('A9:72'), null);
    assert.equal(normalizeSha1('A97:257A7C0D558E2960318FAD7AB8769A3520BDF'), null);
  });
});

describe('injected commands', () => {
  it('split on spaces, or a JSON array for paths with spaces', () => {
    assert.deepEqual(parseCommand('npx eas-cli'), ['npx', 'eas-cli']);
    assert.deepEqual(parseCommand('["C:\\\\Program Files\\\\node.exe", "fake.mjs", "adb"]'), ['C:\\Program Files\\node.exe', 'fake.mjs', 'adb']);
    assert.deepEqual(parseCommand(''), []);
  });
});

describe('screenshot plan', () => {
  const screens = [
    { name: 'shelf', key: true },
    { name: 'out', key: true },
    { name: 'settings', key: false },
  ];

  it('full matrix for key screens; light/dark, first language, 1.0 for the others', () => {
    const plan = buildPlan(screens, ['light', 'dark'], ['en', 'fr'], [1, 1.3]);
    assert.equal(plan.total, 2 * 8 + 2);
    assert.equal(plan.batches.length, 8);
    assert.equal(plan.summary, '2 key screens × 2 modes × 2 languages × 2 font scales + 1 screen × 2 modes = 18, in 8 batches');
    assert.deepEqual(plan.batches[0], { mode: 'light', lang: 'en', scale: 1, screens: ['shelf', 'out', 'settings'] });
    assert.deepEqual(plan.batches[1], { mode: 'light', lang: 'fr', scale: 1, screens: ['shelf', 'out'] });
    const settings = plan.batches.filter((b) => b.screens.includes('settings')).map((b) => `${b.mode} ${b.lang} ${b.scale}`);
    assert.deepEqual(settings, ['light en 1', 'dark en 1']);
  });

  it('without key screens: 2 shots per screen, 2 batches', () => {
    const plan = buildPlan([{ name: 'a', key: false }, { name: 'b', key: false }], ['light', 'dark'], ['en', 'fr'], [1, 1.3]);
    assert.equal(plan.total, 4);
    assert.equal(plan.summary, '2 screens × 2 modes = 4, in 2 batches');
  });

  it('a scale list without 1.0 uses its first scale', () => {
    const plan = buildPlan([{ name: 'a', key: false }], ['light'], ['en'], [1.15, 1.3]);
    assert.deepEqual(plan.batches, [{ mode: 'light', lang: 'en', scale: 1.15, screens: ['a'] }]);
  });
});

describe('memory watchdog and ANR dialog', () => {
  const limits = { minFreeMb: 2048, maxEmulatorMb: 6144 };
  it('restarts below the free RAM floor or above the emulator ceiling', () => {
    assert.equal(memoryPressure({ freeMb: 4000, emulatorMb: 3000 }, limits), null);
    assert.equal(memoryPressure({ freeMb: 1500, emulatorMb: 3000 }, limits), 'free RAM 1500 MB < 2048 MB');
    assert.equal(memoryPressure({ freeMb: 4000, emulatorMb: 7000 }, limits), 'emulator uses 7000 MB > 6144 MB');
  });

  it('finds the Wait button of the ANR dialog', () => {
    const xml =
      '<node resource-id="android:id/aerr_close" bounds="[66,1170][1014,1302]"/>' +
      '<node index="1" text="Wait" resource-id="android:id/aerr_wait" class="android.widget.Button" bounds="[66,1302][1014,1434]"/>';
    assert.deepEqual(waitButtonCentre(xml), [540, 1368]);
    assert.equal(waitButtonCentre('<node resource-id="other"/>'), null);
  });
});

describe('report', () => {
  it('escapes everything that comes from the device or Maestro', () => {
    const html = renderReport({
      appName: 'App <b>',
      androidPackage: 'com.example.app',
      version: '1.0.0',
      versionCode: 3,
      installedVersionCode: 2,
      apk: 'x.apk',
      device: { serial: 'S', model: '<script>alert(1)</script>', manufacturer: '', androidVersion: '14', sdk: 34 },
      startedAt: 'a',
      finishedAt: 'b',
      outDir: '/x',
      plan: 'p',
      saved: null,
      smoke: [{ flow: 'smoke/01.yaml', ok: false, seconds: 1, error: '<img onerror=x>' }],
      shots: [{ screen: 'home', mode: 'light', lang: 'en', scale: 1, error: 'boom' }],
      notes: [],
    });
    assert.ok(!html.includes('<script>alert'));
    assert.ok(!html.includes('<img onerror'));
    assert.ok(html.includes('Installed versionCode: <b class="bad">2</b>'));
    assert.ok(html.includes('No screenshot'));
  });

  it('marks shots not captured and says how to resume an unfinished run', () => {
    const run: QaRun = {
      appName: 'App',
      androidPackage: 'com.example.app',
      version: '1.0.0',
      versionCode: 3,
      installedVersionCode: 3,
      apk: 'x.apk',
      device: { serial: 'S', model: 'M', manufacturer: '', androidVersion: '14', sdk: 34 },
      startedAt: 'a',
      finishedAt: '',
      outDir: '/caps/2026-10-11-v1.0.0',
      plan: '2 screens × 2 modes = 4, in 2 batches',
      saved: null,
      smoke: [],
      shots: [
        { screen: 'home', mode: 'light', lang: 'en', scale: 1, file: 'home_light_en_1.0x.png' },
        { screen: 'home', mode: 'dark', lang: 'en', scale: 1 },
      ],
      notes: [],
    };
    const html = renderReport(run);
    assert.ok(html.includes('Not captured'));
    assert.ok(html.includes('not finished'));
    assert.ok(html.includes('mk qa:device --resume /caps/2026-10-11-v1.0.0'));
    assert.ok(html.includes('Screenshots: 1/2'));
    assert.ok(!renderReport({ ...run, finishedAt: 'b', shots: [run.shots[0]!] }).includes('Incomplete run'));
  });
});
