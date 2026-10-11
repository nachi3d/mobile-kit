// mk emulator and qa:device --emulator, against a FAKE emulator,
// avdmanager and adb (test/fakes/fake.mjs). No real emulator is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { tuneConfigIni } from '../dist/emulator.js';
import { EMULATOR_DEFAULTS } from '../dist/config.js';
import { makeFixture, sideEffects } from './fixture.ts';

const configIni = (home: string) => fs.readFileSync(path.join(home, 'mk-pixel8-api34.avd', 'config.ini'), 'utf8');

describe('mk emulator', () => {
  it('creates the AVD, tunes it, starts it, waits for boot, unlocks, turns animations off', () => {
    const f = makeFixture();
    const r = f.run(['emulator']);
    assert.equal(r.status, 0, r.out);
    const calls = f.calls();
    assert.match(calls, /^avdmanager create avd -n mk-pixel8-api34 -k system-images;android-34;google_apis_playstore;x86_64 -d pixel_8$/m);
    const ini = configIni(f.avdHome);
    assert.match(ini, /^hw\.ramSize=4096M$/m);
    assert.match(ini, /^disk\.dataPartition\.size=8G$/m);
    assert.match(ini, /^hw\.keyboard=yes$/m);
    assert.match(ini, /^hw\.device\.name=pixel_8$/m);
    assert.match(calls, /^emulator -avd mk-pixel8-api34 -no-boot-anim -no-audio$/m);
    assert.match(calls, /getprop sys\.boot_completed/);
    assert.match(calls, /wm dismiss-keyguard/);
    for (const k of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
      assert.match(calls, new RegExp(`settings put global ${k} 0`));
    }
    assert.match(r.out, /emulator-5554\s*$/);
  });

  it('reuses an existing AVD and a running emulator', () => {
    const f = makeFixture();
    f.run(['emulator']);
    f.resetCalls();
    const r = f.run(['emulator']);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('AVD mk-pixel8-api34 exists'));
    assert.ok(r.out.includes('mk-pixel8-api34 is already running: emulator-5554'));
    assert.doesNotMatch(f.calls(), /^(avdmanager|emulator) /m);
  });

  it('--wipe restarts it with -wipe-data', () => {
    const f = makeFixture();
    f.run(['emulator']);
    const r = f.run(['emulator', '--wipe']);
    assert.equal(r.status, 0, r.out);
    assert.match(f.calls(), /emu kill/);
    assert.match(f.calls(), /^emulator -avd mk-pixel8-api34 -no-boot-anim -no-audio -wipe-data$/m);
  });

  it('explains how to install the system image when avdmanager fails', () => {
    const r = makeFixture().run(['emulator'], { FAKE_FAIL: 'avdmanager' });
    assert.notEqual(r.status, 0);
    assert.ok(r.out.includes('Is the system image installed?'));
    assert.ok(r.out.includes('android sdk install system-images/android-34/google_apis_playstore/x86_64'));
  });

  it('uses the AVD settings of the config', () => {
    const f = makeFixture({ config: { emulator: { avd: 'mk-small', ramMb: 2048 } } });
    assert.equal(f.run(['emulator']).status, 0);
    assert.match(f.calls(), /create avd -n mk-small /);
    assert.match(fs.readFileSync(path.join(f.avdHome, 'mk-small.avd', 'config.ini'), 'utf8'), /^hw\.ramSize=2048M$/m);
  });

  it('--dry-run creates, changes and starts nothing', () => {
    const f = makeFixture();
    const r = f.run(['emulator', '--dry-run']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /not executed\].*avdmanager create avd -n mk-pixel8-api34/);
    assert.match(r.out, /not executed\].*emulator -avd mk-pixel8-api34/);
    assert.deepEqual(sideEffects(f.calls()), []);
    assert.deepEqual(fs.readdirSync(f.avdHome), []);
  });

  it('refuses unknown options', () => {
    assert.ok(makeFixture().run(['emulator', '--cold']).out.includes('Unknown option: --cold'));
  });
});

describe('mk qa:device --emulator', () => {
  it('refuses while a physical phone is connected, before starting anything', () => {
    const f = makeFixture();
    const r = f.run(['qa:device', '--emulator', '--dry-run'], { FAKE_ADB_DEVICES: 'R5CX123' });
    assert.notEqual(r.status, 0);
    assert.ok(r.out.includes('a physical device is connected: R5CX123'));
    assert.doesNotMatch(f.calls(), /^(avdmanager|emulator) /m);
  });

  it('starts the emulator and runs the whole QA on it', () => {
    const f = makeFixture();
    const apk = path.join(f.root, 'dist', 'ExampleApp-0.2.0.apk');
    const r = f.run(['qa:device', '--emulator', '--apk', apk, '--yes', '--no-open']);
    assert.equal(r.status, 0, r.out);
    assert.match(f.calls(), /^emulator -avd mk-pixel8-api34/m);
    assert.match(f.calls(), /^adb -s emulator-5554 install -r /m);
    assert.ok(r.out.includes('Screenshots: 2 screens × 2 modes × 2 languages × 2 font scales = 16'));
  });

  it('--dry-run with no device yet: prints the start and the plan on the future serial', () => {
    const f = makeFixture();
    const r = f.run(['qa:device', '--emulator', '--dry-run']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /not executed\].*emulator -avd mk-pixel8-api34/);
    assert.match(r.out, /maestro --device emulator-5554 test/);
    assert.deepEqual(sideEffects(f.calls()), []);
  });
});

describe('tuneConfigIni', () => {
  it('sets the managed keys, keeps the rest, adds missing ones', () => {
    const out = tuneConfigIni('hw.ramSize=2G\r\nhw.lcd.density=420\r\n', EMULATOR_DEFAULTS);
    assert.equal(out, 'hw.ramSize=4096M\nhw.lcd.density=420\ndisk.dataPartition.size=8G\nhw.keyboard=yes\n');
  });
});
