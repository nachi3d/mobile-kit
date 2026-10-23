// mk build --local, qa:device --local-build, release:build --local and
// mk keystore:pull, against a fixture app and FAKE expo / gradlew / keytool /
// eas (test/fakes/fake.mjs): nothing is built, signed or downloaded for real.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { patchBuildGradle, patchGradleProperties } from '../dist/build/local.js';
import { easProfileEnv } from '../dist/eas.js';
import { EAS_JSON, KEY_PASSWORD, makeFixture, sideEffects, STORE_PASSWORD, type Fixture } from './fixture.ts';

const OTHER_SHA1 = 'CD:'.repeat(19) + 'CD';

const fixture = (options: Parameters<typeof makeFixture>[0] = {}) => makeFixture({ easJson: EAS_JSON, withApk: false, ...options });
const build = (f: Fixture, args: string[], env: Record<string, string | undefined> = {}) => f.run(['build', ...args], env);
const apk = (f: Fixture, profile: string) => path.join(f.root, 'dist', `ExampleApp-0.2.0-${profile}.apk`);
const git = (f: Fixture) => execFileSync('git', ['status', '--porcelain'], { cwd: f.root, encoding: 'utf8' });

function refuses(r: { status: number | null; out: string }, message: string) {
  assert.notEqual(r.status, 0, r.out);
  assert.ok(r.out.includes(message), `expected "${message}" in:\n${r.out}`);
}

/** No password in any command line, in mk's output, or in a file of the app. */
function noSecretLeaked(f: Fixture, out: string) {
  for (const secret of [STORE_PASSWORD, KEY_PASSWORD]) {
    assert.ok(!f.calls().includes(secret), 'a password reached a command line');
    assert.ok(!out.includes(secret), 'a password was printed');
    const files = fs.readdirSync(f.root, { recursive: true, encoding: 'utf8' }).filter((x) => !x.startsWith('.git'));
    for (const file of files) {
      const full = path.join(f.root, file);
      if (fs.statSync(full).isFile()) assert.ok(!fs.readFileSync(full, 'utf8').includes(secret), `a password is in ${file}`);
    }
  }
}

describe('mk build --local', () => {
  it('prebuilds with the profile env, signs with the production key from the environment, verifies the APK', () => {
    const f = fixture();
    const r = build(f, ['--local', '--profile', 'universal']);
    assert.equal(r.status, 0, r.out);
    // extends: production's SENTRY, universal's own APP_ABIS.
    assert.ok(f.calls().includes('expo-env APP_ABIS=all SENTRY=off NODE_ENV=production'), f.calls());
    assert.match(f.calls(), /^expo prebuild --platform android --clean --no-install$/m);
    assert.match(f.calls(), /^gradlew assembleRelease --no-daemon --max-workers=2 -Pkotlin\.compiler\.execution\.strategy=in-process$/m);
    assert.ok(f.calls().includes('gradlew-env APP_ABIS=all signing=ok'), f.calls());
    assert.ok(r.out.includes('Signing key OK'));
    assert.ok(r.out.includes('APK OK: com.example.app 0.2.0 (16), signed with the expected key'));
    assert.ok(fs.existsSync(apk(f, 'universal')));
    // android/ is gone, prebuild's package.json edit undone, nothing tracked changed.
    assert.ok(!fs.existsSync(path.join(f.root, 'android')));
    assert.ok(fs.readFileSync(path.join(f.root, 'package.json'), 'utf8').includes('expo start --android'));
    assert.equal(git(f), '');
    noSecretLeaked(f, r.out);
  });

  it('reads MK_KEYSTORE_DIR from .env.local', () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.root, '.env.local'), `MK_KEYSTORE_DIR=${f.keystoreDir}\n`);
    const r = build(f, ['--local', '--profile', 'preview'], { MK_KEYSTORE_DIR: undefined });
    assert.equal(r.status, 0, r.out);
    assert.ok(fs.existsSync(apk(f, 'preview')));
  });

  it('checks everything before building: options, profile, versionCode, key, RAM, gitignore', () => {
    refuses(build(fixture(), ['--profile', 'preview']), 'mk build only builds locally (--local)');
    refuses(build(fixture(), ['--local']), '--profile is required');
    refuses(build(fixture(), ['--local', '--profile', 'store']), 'eas.json has no build profile "store"');
    refuses(build(fixture({ easJson: undefined }), ['--local', '--profile', 'preview']), 'No eas.json');
    refuses(build(fixture({ versionCode: null }), ['--local', '--profile', 'preview']), 'has no expo.android.versionCode');
    refuses(build(fixture(), ['--local', '--profile', 'preview'], { MK_KEYSTORE_DIR: '' }), 'MK_KEYSTORE_DIR is not set');
    refuses(build(fixture({ keystore: false }), ['--local', '--profile', 'preview']), 'Run once: npm run keystore:pull');
    refuses(build(fixture(), ['--local', '--profile', 'preview'], { FAKE_KEYSTORE_SHA1: OTHER_SHA1 }), 'Not the production key');
    refuses(build(fixture(), ['--local', '--profile', 'preview'], { FAKE_STOREPASS: 'other' }), 'keytool cannot read');
    refuses(build(fixture(), ['--local', '--profile', 'preview'], { MK_KEYTOOL: '' }), 'keytool not found');

    const low = fixture();
    const r = build(low, ['--local', '--profile', 'preview'], { FAKE_MEM_SEQ: '3000:0' });
    refuses(r, 'Only 3000 MB of RAM free');
    assert.ok(r.out.includes('Close Brave'));
    assert.deepEqual(sideEffects(low.calls()), []);

    const inRepo = fixture();
    refuses(build(inRepo, ['--local', '--profile', 'preview'], { MK_KEYSTORE_DIR: path.join(inRepo.root, 'keys') }), 'inside the git repository');

    const tracked = fixture();
    tracked.write('.gitignore', 'dist/\n.env.local\n');
    refuses(build(tracked, ['--local', '--profile', 'preview']), 'android/ is not gitignored');
    assert.deepEqual(sideEffects(tracked.calls()), []);
  });

  it('refuses and deletes an APK that is not signed by the production key', () => {
    const f = fixture();
    const r = build(f, ['--local', '--profile', 'preview'], { FAKE_SHA1: OTHER_SHA1 });
    refuses(r, 'Wrong keystore');
    assert.ok(!fs.existsSync(apk(f, 'preview')));
  });

  it('a failed Gradle build still removes android/ and restores package.json', () => {
    const f = fixture();
    refuses(build(f, ['--local', '--profile', 'preview'], { FAKE_FAIL: 'gradle' }), 'Gradle build failed');
    assert.ok(!fs.existsSync(path.join(f.root, 'android')));
    assert.equal(git(f), '');
  });

  it('dry run: checks the key and RAM, prints prebuild and Gradle, runs neither', () => {
    const f = fixture();
    const r = build(f, ['--local', '--profile', 'production', '--dry-run']);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('Signing key OK'));
    assert.match(r.out, /not executed\].*expo'? prebuild --platform android --clean --no-install/);
    assert.match(r.out, /not executed\].*gradlew'? assembleRelease --no-daemon --max-workers=2/);
    assert.deepEqual(sideEffects(f.calls()), []);
    noSecretLeaked(f, r.out);
  });
});

describe('qa:device --local-build and release:build --local', () => {
  it('qa:device builds the qa profile locally before the emulator starts, then installs it', () => {
    const f = fixture();
    const r = f.run(['qa:device', '--local-build', '--emulator', '--yes', '--no-open'], {});
    assert.equal(r.status, 0, r.out);
    const calls = f.calls();
    assert.ok(calls.indexOf('gradlew assembleRelease') < calls.indexOf('emulator '), 'the build runs before the emulator');
    assert.match(calls, /install -r .*ExampleApp-0\.2\.0-preview\.apk/);
    assert.ok(r.out.includes('Expected versionCode 16 (app.json)'));
    noSecretLeaked(f, r.out);
  });

  it('qa:device --local-build does not go with --apk, --skip-build or --resume', () => {
    const f = fixture();
    refuses(f.run(['qa:device', '--local-build', '--skip-build']), 'cannot go with --apk, --skip-build or --resume');
  });

  it('release:build --local --dry-run: the local build instead of EAS, then the usual checks', () => {
    const f = fixture();
    const r = f.run(['release:build', '0.2.0', '--local', '--dry-run'], { FAKE_ADB_DEVICES: 'PHONE1' });
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('Local build of profile production → dist/ExampleApp-0.2.0.apk'));
    assert.ok(!/eas build -p android/.test(r.out), 'no EAS build');
    assert.match(r.out, /not executed\].*r2 object put/);
    assert.deepEqual(sideEffects(f.calls()), []);
  });
});

describe('mk keystore:pull', () => {
  it('moves what eas credentials downloaded out of the app, checks it, leaves nothing behind', () => {
    const f = fixture({ keystore: false });
    const r = f.run(['keystore:pull']);
    assert.equal(r.status, 0, r.out);
    assert.match(f.calls(), /^eas credentials -p android$/m);
    assert.ok(r.out.includes('Download credentials from EAS to credentials.json'));
    assert.ok(!fs.existsSync(path.join(f.root, 'credentials.json')));
    assert.ok(!fs.existsSync(path.join(f.root, 'credentials')));
    // Moved as EAS wrote them: credentials.json unchanged, the keystore at its relative keystorePath.
    const saved = JSON.parse(fs.readFileSync(path.join(f.keystoreDir, 'credentials.json'), 'utf8'));
    assert.equal(saved.android.keystore.keystorePath, 'credentials/android/keystore.jks');
    assert.ok(fs.existsSync(path.join(f.keystoreDir, 'credentials', 'android', 'keystore.jks')));
    assert.match(f.calls(), /^keytool -J-Duser\.language=en .*-storepass:env MK_KEYTOOL_STOREPASS$/m);
    assert.equal(git(f), '');
    noSecretLeaked(f, r.out);
    // The pulled key builds: keystorePath is read against MK_KEYSTORE_DIR.
    const b = build(f, ['--local', '--profile', 'preview']);
    assert.equal(b.status, 0, b.out);
    assert.ok(f.calls().includes('gradlew-env APP_ABIS=arm64-v8a,x86_64 signing=ok'), f.calls());
  });

  it('a password with shell characters reaches keytool and Gradle intact, never a command line', () => {
    const f = fixture({ keystore: false });
    const password = `p@ss"w%rd!^&|<>$\`'x y;*`;
    const r = f.run(['keystore:pull'], { FAKE_STOREPASS: password });
    assert.equal(r.status, 0, r.out);
    assert.equal(build(f, ['--local', '--profile', 'preview'], { FAKE_STOREPASS: password }).status, 0);
    assert.ok(f.calls().includes('signing=ok'), f.calls());
    assert.ok(!f.calls().includes(password) && !r.out.includes(password));
  });

  it('files an earlier pull left in the app folder: moved, eas not run', () => {
    const f = fixture({ keystore: false });
    f.write('credentials/android/keystore.jks', 'fake keystore');
    const keystore = { keystorePath: 'credentials/android/keystore.jks', keystorePassword: STORE_PASSWORD, keyAlias: 'upload', keyPassword: KEY_PASSWORD };
    f.write('credentials.json', JSON.stringify({ android: { keystore } }));
    const r = f.run(['keystore:pull']);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('eas is not run'));
    assert.ok(!/^eas /m.test(f.calls()), f.calls());
    assert.ok(fs.existsSync(path.join(f.keystoreDir, 'credentials', 'android', 'keystore.jks')));
    assert.ok(!fs.existsSync(path.join(f.root, 'credentials.json')));
    assert.ok(!fs.existsSync(path.join(f.root, 'credentials')));
  });

  it('an absolute keystorePath inside the app: rewritten relative to the keystore folder', () => {
    const f = fixture({ keystore: false });
    f.write('keys/upload.jks', 'fake keystore');
    const keystore = { keystorePath: path.join(f.root, 'keys', 'upload.jks'), keystorePassword: STORE_PASSWORD, keyAlias: 'upload', keyPassword: KEY_PASSWORD };
    f.write('credentials.json', JSON.stringify({ android: { keystore } }));
    const r = f.run(['keystore:pull']);
    assert.equal(r.status, 0, r.out);
    const saved = JSON.parse(fs.readFileSync(path.join(f.keystoreDir, 'credentials.json'), 'utf8'));
    assert.equal(saved.android.keystore.keystorePath, 'keys/upload.jks');
    assert.ok(fs.existsSync(path.join(f.keystoreDir, 'keys', 'upload.jks')));
    assert.ok(!fs.existsSync(path.join(f.root, 'keys')));
  });

  it('refuses to overwrite, a keystore folder inside a repo, and files that git would track', () => {
    refuses(fixture().run(['keystore:pull']), 'already exists. To pull again');
    const f = fixture({ keystore: false });
    refuses(f.run(['keystore:pull'], { MK_KEYSTORE_DIR: path.join(f.root, 'secrets') }), 'inside the git repository');
    f.write('.gitignore', 'dist/\n');
    refuses(f.run(['keystore:pull']), 'credentials.json is not gitignored');
    assert.deepEqual(sideEffects(f.calls()), []);
  });

  it('nothing downloaded (cancelled): says so', () => {
    const f = fixture({ keystore: false });
    refuses(f.run(['keystore:pull'], { FAKE_EAS_NO_CREDENTIALS: '1' }), 'No credentials.json was downloaded');
    assert.ok(!fs.existsSync(path.join(f.keystoreDir, 'credentials.json')));
  });

  /** After a failed check: the files are in the keystore folder, none in the app, git clean. */
  function movedNotDeleted(f: Fixture) {
    assert.ok(fs.existsSync(path.join(f.keystoreDir, 'credentials.json')), 'credentials.json deleted');
    assert.ok(fs.existsSync(path.join(f.keystoreDir, 'credentials', 'android', 'keystore.jks')), 'keystore deleted');
    assert.ok(!fs.existsSync(path.join(f.root, 'credentials.json')));
    assert.ok(!fs.existsSync(path.join(f.root, 'credentials')));
    assert.equal(git(f), '');
  }

  it('another key (wrong profile): refused, moved out of the app and kept', () => {
    const f = fixture({ keystore: false });
    const r = f.run(['keystore:pull'], { FAKE_KEYSTORE_SHA1: OTHER_SHA1 });
    refuses(r, 'Not the production key');
    assert.ok(r.out.includes('The pulled files are kept in'));
    movedNotDeleted(f);
  });

  it('keytool missing: says where it looked, the files are moved anyway', () => {
    const f = fixture({ keystore: false });
    const r = f.run(['keystore:pull'], { MK_KEYTOOL: '' });
    refuses(r, 'keytool not found (looked in PATH, JAVA_HOME');
    movedNotDeleted(f);
    noSecretLeaked(f, r.out);
  });

  it('keytool fails: its exit code and error are shown, the password masked, the files moved anyway', () => {
    // credentials.json has a password the keystore does not take.
    const g = fixture({ keystore: false });
    g.write('credentials/android/keystore.jks', 'fake keystore');
    const keystore = { keystorePath: 'credentials/android/keystore.jks', keystorePassword: STORE_PASSWORD, keyAlias: 'upload', keyPassword: KEY_PASSWORD };
    g.write('credentials.json', JSON.stringify({ android: { keystore } }));
    const bad = g.run(['keystore:pull'], { FAKE_STOREPASS: 'what-the-keystore-wants' });
    refuses(bad, 'keytool cannot read');
    assert.ok(bad.out.includes('exit code 1'));
    assert.ok(bad.out.includes('password was incorrect (***)'), bad.out);
    movedNotDeleted(g);
    noSecretLeaked(g, bad.out);
  });

  it('dry run: prints eas credentials, runs it not', () => {
    const f = fixture({ keystore: false });
    const r = f.run(['keystore:pull', '--dry-run']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /not executed\].*eas'? credentials -p android/);
    assert.deepEqual(sideEffects(f.calls()), []);
  });
});

describe('local build helpers', () => {
  const TEMPLATE = [
    'android {',
    '    signingConfigs {',
    '        debug {',
    "            storeFile file('debug.keystore')",
    '        }',
    '    }',
    '    buildTypes {',
    '        debug {',
    '            signingConfig signingConfigs.debug',
    '        }',
    '        release {',
    '            signingConfig signingConfigs.debug',
    '        }',
    '    }',
    '}',
  ].join('\r\n');

  it('signs release (only) with a config read from the environment', () => {
    const out = patchBuildGradle(TEMPLATE);
    assert.match(out, /signingConfigs \{\r\n {8}mkRelease \{/);
    assert.match(out, /debug \{\r\n {12}signingConfig signingConfigs\.debug/);
    assert.match(out, /release \{\r\n {12}signingConfig signingConfigs\.mkRelease/);
    for (const v of ['MK_SIGNING_STORE_FILE', 'MK_SIGNING_STORE_PASSWORD', 'MK_SIGNING_KEY_ALIAS', 'MK_SIGNING_KEY_PASSWORD']) {
      assert.ok(out.includes(`System.getenv("${v}")`));
    }
    assert.throws(() => patchBuildGradle('android {}'), /Expo template changed/);
  });

  it('gives Gradle 3 GB and 2 workers, replacing the template values', () => {
    const out = patchGradleProperties('org.gradle.jvmargs=-Xmx2048m\norg.gradle.parallel=true\nnewArchEnabled=true\n');
    assert.ok(out.includes('org.gradle.jvmargs=-Xmx3g'));
    assert.ok(out.includes('org.gradle.workers.max=2'));
    assert.ok(out.includes('org.gradle.parallel=false'));
    assert.ok(!out.includes('-Xmx2048m'));
    assert.ok(out.includes('newArchEnabled=true'));
  });

  it('applies eas.json extends like EAS', () => {
    const f = fixture();
    assert.deepEqual(easProfileEnv(f.root, 'universal'), { APP_ABIS: 'all', SENTRY: 'off' });
    assert.deepEqual(easProfileEnv(f.root, 'preview'), { APP_ABIS: 'arm64-v8a,x86_64' });
  });
});
