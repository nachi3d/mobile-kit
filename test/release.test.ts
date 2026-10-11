// mk release:build / release:promote, ALWAYS with --dry-run, against a
// fixture app and fakes only (test/fixture.ts).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { APK_BYTES, makeFixture, sideEffects, TOKEN, type Fixture } from './fixture.ts';

const build = (f: Fixture, args: string[], env?: Record<string, string | undefined>) => f.run(['release:build', ...args], env);
const promote = (f: Fixture, args: string[], env?: Record<string, string | undefined>, input = 'y\n') =>
  f.run(['release:promote', ...args], env, input);

function refuses(r: { status: number | null; out: string }, message: string) {
  assert.notEqual(r.status, 0, r.out);
  assert.ok(r.out.includes(message), `expected "${message}" in:\n${r.out}`);
}

describe('mk release:build (dry run, fakes only)', () => {
  it('refuses without a version, with an unknown option or a bad version', () => {
    const f = makeFixture();
    refuses(build(f, ['--dry-run']), 'Usage: mk release:build');
    refuses(build(f, ['0.2.0', '--dry-run', '--force']), 'Unknown option: --force');
    refuses(build(f, ['v0.2', '--dry-run']), 'Not a version');
  });

  it('refuses a test fixture without --dry-run, before anything else', () => {
    const f = makeFixture();
    refuses(build(f, ['0.2.0']), 'works only with --dry-run');
    assert.equal(f.calls(), '');
  });

  it('refuses a test fixture when a command is not injected', () => {
    const f = makeFixture();
    refuses(build(f, ['0.2.0', '--dry-run'], { MK_WRANGLER: undefined }), 'MK_WRANGLER must be injected');
    assert.equal(f.calls(), '');
  });

  it('refuses an invalid config, listing every problem', () => {
    const f = makeFixture({ config: { signingSha1: 'TO FILL', downloadsHost: 'https://x.com/', screens: 'home' } });
    const r = build(f, ['0.2.0', '--dry-run']);
    refuses(r, '"signingSha1" must be the 20-byte certificate SHA-1');
    assert.ok(r.out.includes('"downloadsHost" is a host name'));
    assert.ok(r.out.includes('"screens" must be a list'));
  });

  it('refuses when app.json and the config name different packages', () => {
    const f = makeFixture({ config: { androidPackage: 'com.example.other' } });
    refuses(build(f, ['0.2.0', '--dry-run']), 'mobile-kit.config.json says com.example.other');
  });

  it('refuses when HEAD is not the version tag', () => {
    const f = makeFixture();
    f.write('NOTES.md', 'x');
    for (const args of [['add', '.'], ['commit', '-q', '-m', 'after the tag']]) {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.com', ...args], { cwd: f.root });
    }
    refuses(build(f, ['0.2.0', '--dry-run']), 'HEAD is not tag v0.2.0');
  });

  it('refuses a version that is not app.json’s', () => {
    const f = makeFixture();
    refuses(build(f, ['0.3.0', '--dry-run']), 'does not match app.json (0.2.0)');
  });

  it('refuses a dirty working tree', () => {
    const f = makeFixture();
    f.write('stray.txt', 'x');
    refuses(build(f, ['0.2.0', '--dry-run']), 'not clean');
  });

  it('refuses without .env.local', () => {
    refuses(build(makeFixture({ envLocal: null }), ['0.2.0', '--dry-run']), '.env.local is missing');
  });

  it('refuses when the versioned key already exists, before building', () => {
    const f = makeFixture();
    const r = build(f, ['0.2.0', '--dry-run'], { FAKE_HEAD_STATUS: '200' });
    refuses(r, 'already exists on R2');
    assert.ok(!r.out.includes('EAS build'));
    assert.deepEqual(sideEffects(f.calls()), []);
  });

  it('refuses when the existence check cannot reach the server', () => {
    refuses(build(makeFixture(), ['0.2.0', '--dry-run'], { FAKE_HEAD_STATUS: '503' }), 'Cannot check');
  });

  for (const [label, env, message] of [
    ['a wrong package', { FAKE_PKG: 'com.example.evil' }, "Package is 'com.example.evil'"],
    ['a wrong versionName', { FAKE_VN: '0.1.1' }, "versionName is '0.1.1'"],
    ['a wrong versionCode', { FAKE_VC: '14' }, "versionCode is '14'"],
    ['an unsigned APK', { FAKE_UNSIGNED: '1' }, 'not signed'],
    ['another signing key', { FAKE_SHA1: 'CD:'.repeat(19) + 'CD' }, 'Wrong keystore'],
  ] as const) {
    it(`refuses ${label}`, () => {
      const f = makeFixture();
      const r = build(f, ['0.2.0', '--dry-run'], env);
      refuses(r, message);
      assert.ok(!r.out.includes('Uploading'));
      assert.deepEqual(sideEffects(f.calls()), []);
    });
  }

  it('warns and goes on when the build-tools are missing', () => {
    const r = build(makeFixture(), ['0.2.0', '--dry-run'], { MK_AAPT: '', MK_APKSIGNER: '' });
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('signature NOT verified'));
  });

  it('dry run: verifies, prints the build, upload and install, executes none', () => {
    const f = makeFixture();
    const r = build(f, ['0.2.0', '--dry-run'], { FAKE_ADB_DEVICES: 'PHONE1' });
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('APK OK: com.example.app 0.2.0 (16)'));
    assert.match(r.out, /\[dry run, not executed\] .*fake\.mjs'? eas build -p android --profile production --non-interactive --wait --json/);
    assert.match(r.out, /not executed\].*r2 object put example-downloads\/exampleapp\/0\.2\.0\/ExampleApp-0\.2\.0\.apk --remote/);
    assert.ok(r.out.includes('max-age=31536000'));
    assert.ok(!r.out.includes('latest.apk --remote'));
    assert.match(r.out, /not executed\].*-s PHONE1 install -r/);
    assert.ok(r.out.includes('Installed versionCode on PHONE1: 15'));
    assert.ok(r.out.includes('Test this build on the phone, then run release:promote'));
    assert.deepEqual(sideEffects(f.calls()), []);
  });

  it('uses the release EAS profile of the config', () => {
    const r = build(makeFixture({ config: { easProfiles: { qa: 'preview', release: 'store' } } }), ['0.2.0', '--dry-run']);
    assert.match(r.out, /build -p android --profile store /);
  });

  it('prints manual install steps without exactly one phone', () => {
    const f = makeFixture();
    assert.ok(build(f, ['0.2.0', '--dry-run']).out.includes('0 phone(s) connected'));
    assert.ok(build(f, ['0.2.0', '--dry-run'], { FAKE_ADB_DEVICES: 'A B' }).out.includes('2 phone(s) connected'));
    assert.deepEqual(sideEffects(f.calls()), []);
  });
});

describe('mk release:promote (dry run, fakes only)', () => {
  const live = { FAKE_HEAD_STATUS: '200', FAKE_HEAD_LENGTH: String(Buffer.byteLength(APK_BYTES)) };

  it('refuses a test fixture without --dry-run', () => {
    const f = makeFixture();
    refuses(promote(f, ['0.2.0'], live), 'works only with --dry-run');
    assert.equal(f.calls(), '');
  });

  it('refuses without the Cloudflare settings in .env.local', () => {
    refuses(promote(makeFixture({ envLocal: 'CF_ZONE_ID=zone123\n' }), ['0.2.0', '--dry-run'], live), 'CF_PURGE_TOKEN is missing');
    refuses(promote(makeFixture({ envLocal: `CF_PURGE_TOKEN=${TOKEN}\n` }), ['0.2.0', '--dry-run'], live), 'CF_ZONE_ID is missing');
  });

  it('refuses without the APK in dist/', () => {
    refuses(promote(makeFixture({ withApk: false }), ['0.2.0', '--dry-run'], live), 'No APK at dist/ExampleApp-0.2.0.apk');
  });

  it('refuses when the versioned object is not on R2', () => {
    const f = makeFixture();
    refuses(promote(f, ['0.2.0', '--dry-run'], { FAKE_HEAD_STATUS: '404' }), 'is not on R2');
    assert.deepEqual(sideEffects(f.calls()), []);
  });

  it('refuses when the R2 object size differs from dist/', () => {
    const f = makeFixture();
    refuses(promote(f, ['0.2.0', '--dry-run'], { FAKE_HEAD_STATUS: '200', FAKE_HEAD_LENGTH: '137' }), 'not the same file');
    assert.deepEqual(sideEffects(f.calls()), []);
  });

  for (const answer of ['n\n', '\n', '']) {
    it(`stops unless the answer is yes (${JSON.stringify(answer)})`, () => {
      const r = promote(makeFixture(), ['0.2.0', '--dry-run'], live, answer);
      refuses(r, 'Not promoted');
      assert.ok(r.out.includes('Promote 0.2.0 to latest? [y/N]'));
      assert.ok(!r.out.includes('Uploading'));
    });
  }

  it('dry run after yes: prints the upload and the purge, never the token', () => {
    const f = makeFixture();
    const r = promote(f, ['0.2.0', '--dry-run'], live);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /not executed\].*r2 object put example-downloads\/exampleapp\/latest\.apk --remote/);
    assert.ok(r.out.includes('--cache-control no-cache'));
    assert.ok(r.out.includes('zones/zone123/purge_cache'));
    assert.ok(r.out.includes('Bearer ***'));
    assert.ok(r.out.includes('https://downloads.example.com/exampleapp/0.2.0/ExampleApp-0.2.0.apk'));
    assert.ok(r.out.includes('https://downloads.example.com/exampleapp/latest.apk'));
    assert.ok(!r.out.includes(TOKEN));
    assert.ok(!f.calls().includes(TOKEN));
    assert.deepEqual(sideEffects(f.calls()), []);
  });
});

describe('the kit source', () => {
  it('names no app: everything app-specific comes from the config', () => {
    const files = fs.readdirSync(path.join(import.meta.dirname, '..', 'src'), { recursive: true, encoding: 'utf8' });
    const src = files
      .filter((f) => f.endsWith('.ts'))
      .map((f) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', f), 'utf8'))
      .join('\n');
    assert.doesNotMatch(src, /booktrack|mangatrack|gametrack|nachi3d-downloads|nachi3dlabs/i);
  });
});

