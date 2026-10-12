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
    assert.match(ini, /^hw\.gpu\.enabled=yes$/m);
    assert.match(ini, /^hw\.gpu\.mode=host$/m);
    assert.match(calls, /^emulator -avd mk-pixel8-api34 -no-boot-anim -no-audio -gpu host$/m);
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
    assert.match(f.calls(), /^emulator -avd mk-pixel8-api34 -no-boot-anim -no-audio -gpu host -wipe-data$/m);
  });

  it('falls back to swiftshader_indirect once when the host GPU does not boot', () => {
    const f = makeFixture();
    const r = f.run(['emulator'], { FAKE_FAIL: 'emulator:host' });
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('GPU mode "host" did not boot: retrying once with swiftshader_indirect'));
    assert.match(f.calls(), /^emulator .* -gpu host$/m);
    assert.match(f.calls(), /^emulator .* -gpu swiftshader_indirect$/m);
    // The config keeps host: the fallback is for this boot only.
    assert.match(configIni(f.avdHome), /^hw\.gpu\.mode=host$/m);
  });

  it('stops with help when neither GPU mode boots', () => {
    const r = makeFixture().run(['emulator'], { FAKE_FAIL: 'emulator:host,emulator:swiftshader_indirect' });
    assert.notEqual(r.status, 0);
    assert.ok(r.out.includes('did not start'));
  });

  it('headless and another GPU mode from the config', () => {
    const f = makeFixture({ config: { emulator: { headless: true, gpu: 'angle_indirect' } } });
    assert.equal(f.run(['emulator']).status, 0);
    assert.match(f.calls(), /^emulator -avd mk-pixel8-api34 -no-boot-anim -no-audio -gpu angle_indirect -no-window$/m);
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
    assert.ok(r.out.includes('Screenshots: 2 screens × 2 modes = 4, in 2 batches'));
  });

  it('cold-restarts the emulator before each batch after the smoke flows, and stops it at the end', () => {
    const f = makeFixture();
    const apk = path.join(f.root, 'dist', 'ExampleApp-0.2.0.apk');
    const r = f.run(['qa:device', '--emulator', '--apk', apk, '--yes', '--no-open']);
    assert.equal(r.status, 0, r.out);
    const boots = [...f.calls().matchAll(/^emulator .*$/gm)].map((m) => m[0]);
    assert.equal(boots.length, 3);
    assert.equal(boots.filter((b) => b.endsWith('-no-snapshot')).length, 2);
    assert.equal([...f.calls().matchAll(/emu kill/g)].length, 3);
    assert.ok(r.out.includes('Stopping the emulator (mk started it'));
    assert.equal(f.state().emulator, '');
  });

  it('--keep-emulator leaves it running; an emulator mk did not start is never stopped', () => {
    const f = makeFixture();
    const apk = path.join(f.root, 'dist', 'ExampleApp-0.2.0.apk');
    f.run(['qa:device', '--emulator', '--apk', apk, '--yes', '--no-open', '--keep-emulator']);
    assert.equal(f.state().emulator, 'mk-pixel8-api34');
    // Already running, and no screenshots: nothing restarted, nothing started by this run.
    const g = makeFixture({ config: { screens: [] } });
    const r = g.run(['qa:device', '--emulator', '--apk', path.join(g.root, 'dist', 'ExampleApp-0.2.0.apk'), '--yes', '--no-open'], {
      FAKE_EMULATOR_RUNNING: 'mk-pixel8-api34',
    });
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(g.calls(), /emu kill/);
    assert.equal(g.state().emulator, 'mk-pixel8-api34');
  });

  it('watchdog: low free RAM or a big emulator restarts it after the current capture, then continues', () => {
    const f = makeFixture({ config: { modes: ['light'] } });
    const apk = path.join(f.root, 'dist', 'ExampleApp-0.2.0.apk');
    const r = f.run(['qa:device', '--emulator', '--apk', apk, '--yes', '--no-open'], { FAKE_MEM_SEQ: '1500:3000,8000:2000' });
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('Memory: free RAM 1500 MB < 2048 MB: restarted the emulator before settings'));
    // Initial boot, the batch restart after the smoke flows, the watchdog restart.
    assert.equal([...f.calls().matchAll(/^emulator /gm)].length, 3);
    const html = fs.readFileSync(path.join(f.root, '.images', 'captures', fs.readdirSync(path.join(f.root, '.images', 'captures'))[0]!, 'report.html'), 'utf8');
    assert.ok(html.includes('Screenshots: 2/2'));
    const big = makeFixture({ config: { modes: ['light'] } });
    const r2 = big.run(['qa:device', '--emulator', '--apk', path.join(big.root, 'dist', 'ExampleApp-0.2.0.apk'), '--yes', '--no-open'], {
      FAKE_MEM_SEQ: '9000:7000,9000:2000',
    });
    assert.ok(r2.out.includes('emulator uses 7000 MB > 6144 MB'));
  });

  it('kills the emulator processes when adb emu kill does not stop it', () => {
    const f = makeFixture();
    f.run(['emulator']);
    f.resetCalls();
    // A wedged emulator: adb emu kill does nothing, the processes must go.
    const r = f.run(['emulator', '--wipe'], { FAKE_FAIL: 'emu-kill' });
    assert.ok(r.out.includes('did not stop with "adb emu kill": killing its processes'));
    assert.match(f.calls(), /^procs kill-emulator mk-pixel8-api34$/m);
  });

  it('--dry-run with no device yet: prints the start and the plan on the future serial', () => {
    const f = makeFixture();
    const r = f.run(['qa:device', '--emulator', '--dry-run']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /not executed\].*emulator -avd mk-pixel8-api34/);
    assert.match(r.out, /maestro --device emulator-5554 test/);
    assert.match(r.out, /not executed\].*maestro --device emulator-5554 hierarchy/);
    assert.deepEqual(sideEffects(f.calls()), []);
  });
});

describe('mk qa:device --emulator: Maestro health check and batch retry', () => {
  const apkOf = (f: { root: string }) => path.join(f.root, 'dist', 'ExampleApp-0.2.0.apk');
  const reportOf = (f: { root: string }) => {
    const base = path.join(f.root, '.images', 'captures');
    return fs.readFileSync(path.join(base, fs.readdirSync(base)[0]!, 'report.html'), 'utf8');
  };
  const count = (text: string, re: RegExp) => [...text.matchAll(re)].length;

  it('checks that Maestro reaches the emulator after every boot', () => {
    const f = makeFixture();
    const r = f.run(['qa:device', '--emulator', '--apk', apkOf(f), '--yes', '--no-open']);
    assert.equal(r.status, 0, r.out);
    // First boot + one cold restart per batch (2), each checked once.
    assert.equal(count(f.calls(), /^emulator /gm), 3);
    assert.equal(count(f.calls(), /^maestro --device emulator-5554 hierarchy$/gm), 3);
    assert.equal(count(f.calls(), /^procs kill-maestro emulator-5554$/gm), 3 + 2);
    assert.doesNotMatch(f.calls(), / uninstall /);
  });

  it('reinstalls the Maestro driver when the check fails after a cold restart, then goes on', () => {
    const f = makeFixture();
    const r = f.run(['qa:device', '--emulator', '--apk', apkOf(f), '--yes', '--no-open'], { FAKE_DRIVER_BROKEN_BOOTS: '2' });
    assert.equal(r.status, 0, r.out);
    const calls = f.calls();
    assert.match(calls, /^adb -s emulator-5554 uninstall dev\.mobile\.maestro$/m);
    assert.match(calls, /^adb -s emulator-5554 uninstall dev\.mobile\.maestro\.test$/m);
    assert.equal(count(calls, /^maestro --device emulator-5554 hierarchy$/gm), 4);
    const html = reportOf(f);
    assert.ok(html.includes('Maestro could not reach emulator-5554 after the boot: reinstalling its driver'));
    assert.ok(!html.includes('still cannot reach'));
    assert.ok(html.includes('Screenshots: 4/4'));
  });

  it('a batch lost to a broken boot is retried once after another cold restart', () => {
    const f = makeFixture();
    const r = f.run(['qa:device', '--emulator', '--apk', apkOf(f), '--yes', '--no-open'], { FAKE_BAD_BOOTS: '2' });
    assert.equal(r.status, 0, r.out);
    // First boot, batch 1 (broken), its retry, batch 2.
    assert.equal(count(f.calls(), /^emulator /gm), 4);
    const html = reportOf(f);
    assert.ok(html.includes('Maestro still cannot reach emulator-5554 after reinstalling its driver'));
    assert.ok(html.includes('light · en · 1.0×: 2 of 2 screenshots failed: retrying the whole batch once after a cold restart'));
    assert.ok(html.includes('Screenshots: 4/4'));
    assert.ok(!html.includes('No screenshot'));
  });

  it('two broken boots in a row: the batch is retried only once, then marked failed', () => {
    const f = makeFixture();
    const r = f.run(['qa:device', '--emulator', '--apk', apkOf(f), '--yes', '--no-open'], { FAKE_BAD_BOOTS: '2,3' });
    assert.notEqual(r.status, 0);
    assert.ok(r.out.includes('2 screenshot(s) missing'));
    const html = reportOf(f);
    assert.ok(html.includes('Flow failed: Launch app &quot;${APP_ID}&quot;: Unable to launch app com.example.app'));
    assert.equal(count(html, /retrying the whole batch/g), 1);
    assert.ok(html.includes('Screenshots: 2/4'));
  });
});

describe('tuneConfigIni', () => {
  it('sets the managed keys, keeps the rest, adds missing ones', () => {
    const out = tuneConfigIni('hw.ramSize=2G\r\nhw.lcd.density=420\r\nhw.gpu.mode=auto\r\n', EMULATOR_DEFAULTS);
    assert.equal(
      out,
      'hw.ramSize=4096M\nhw.lcd.density=420\nhw.gpu.mode=host\ndisk.dataPartition.size=8G\nhw.keyboard=yes\nhw.gpu.enabled=yes\n',
    );
  });
});
