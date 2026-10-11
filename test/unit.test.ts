import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeSha1, validateConfig } from '../dist/config.js';
import { parseCommand } from '../dist/exec.js';
import { renderReport } from '../dist/qa/report.js';
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
      smoke: [{ flow: 'smoke/01.yaml', ok: false, seconds: 1, error: '<img onerror=x>' }],
      shots: [{ screen: 'home', mode: 'light', lang: 'en', scale: 1, error: 'boom' }],
      notes: [],
    });
    assert.ok(!html.includes('<script>alert'));
    assert.ok(!html.includes('<img onerror'));
    assert.ok(html.includes('Installed versionCode: <b class="bad">2</b>'));
    assert.ok(html.includes('No screenshot'));
  });
});
