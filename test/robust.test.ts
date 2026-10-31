// 0.3.2: what the 2026-10-23 emulator run taught. The JDK check and the
// Gradle failure cause, Android's own ANR dialogs, the known device state,
// software rendering, --retry-failed, --migration-from and the guard that
// cleans up after a killed run. Fakes only (test/fakes/fake.mjs), except
// the guard's own test, which runs the real procs.js against test processes.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { isSoftwareRenderer, isSystemAnr } from '../dist/android.js';
import { gradleFailure, whatWentWrong } from '../dist/build/gradle-failure.js';
import { softwareRenderingWarning } from '../dist/emulator.js';
import { guardStep } from '../dist/guard.js';
import { findJdkCandidates, javaMajor, jdkProblem, readJdk, setJavaHomeHint } from '../dist/java.js';
import { ancestors, descendants, etimeSeconds, type Proc } from '../dist/proctree.js';
import { keptSmoke, parseQaArgs } from '../dist/qa/device.js';
import { EAS_JSON, KIT, makeFixture, sideEffects, type Fixture } from './fixture.ts';

const ONE = { FAKE_ADB_DEVICES: 'EMU1' };
const qa = (f: Fixture, args: string[], env: Record<string, string | undefined> = {}, input = '') =>
  f.run(['qa:device', ...args], { ...ONE, ...env }, input);
const apkArgs = (f: Fixture) => ['--apk', path.join(f.root, 'dist', 'ExampleApp-0.2.0.apk')];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mk-robust-'));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function refuses(r: { status: number | null; out: string }, message: string) {
  assert.notEqual(r.status, 0, r.out);
  assert.ok(r.out.includes(message), `expected "${message}" in:\n${r.out}`);
}

function captureDir(f: Fixture): string {
  const base = path.join(f.root, '.images', 'captures');
  const dirs = fs.readdirSync(base);
  assert.equal(dirs.length, 1);
  return path.join(base, dirs[0]!);
}
const report = (f: Fixture) => fs.readFileSync(path.join(captureDir(f), 'report.html'), 'utf8');

/** A fake Java home outside any fixture. */
function javaHome(dir: string, version: string, javac: boolean): string {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'release'), `JAVA_VERSION="${version}"\n`);
  if (javac) fs.writeFileSync(path.join(dir, 'bin', 'javac.exe'), '');
  return dir;
}

// --- 1. JDK check ---------------------------------------------------------------

describe('JAVA_HOME must be a JDK 17', () => {
  it('reads the version from the release file, old and new numbering', () => {
    assert.equal(javaMajor('17.0.18'), 17);
    assert.equal(javaMajor('21'), 21);
    assert.equal(javaMajor('1.8.0_392'), 8);
    assert.equal(javaMajor('x'), null);
    const home = javaHome(path.join(tmp(), 'jdk'), '17.0.18', true);
    assert.deepEqual({ ...readJdk(home), javac: !!readJdk(home).javac }, { home, javac: true, major: 17, version: '17.0.18' });
  });

  it('names each problem: unset, missing folder, a JRE (no javac), another JDK; none for a JDK 17', () => {
    const base = tmp();
    const empty = { ProgramFiles: path.join(base, 'none') };
    assert.match(jdkProblem({ ...empty }, 'win32') ?? '', /JAVA_HOME is not set/);
    assert.match(jdkProblem({ ...empty, JAVA_HOME: path.join(base, 'gone') }, 'win32') ?? '', /does not exist/);
    const jre = javaHome(path.join(base, 'jre-21'), '21.0.12', false);
    assert.match(jdkProblem({ ...empty, JAVA_HOME: jre }, 'win32') ?? '', /a JRE, it has no bin.javac/);
    const jdk21 = javaHome(path.join(base, 'jdk-21'), '21.0.5', true);
    assert.match(jdkProblem({ ...empty, JAVA_HOME: jdk21 }, 'win32') ?? '', /JDK 21 \(Java 21\.0\.5\); the Android build needs JDK 17/);
    const jdk17 = javaHome(path.join(base, 'jdk-17'), '17.0.18', true);
    assert.equal(jdkProblem({ ...empty, JAVA_HOME: jdk17 }, 'win32'), null);
  });

  it('suggests setx with an installed JDK 17 when there is one, else how to install it', () => {
    const programFiles = tmp();
    javaHome(path.join(programFiles, 'Eclipse Adoptium', 'jre-21.0.12'), '21.0.12', false);
    const jdk = javaHome(path.join(programFiles, 'Microsoft', 'jdk-17.0.18.8-hotspot'), '17.0.18', true);
    assert.deepEqual(findJdkCandidates({ ProgramFiles: programFiles }), [jdk]);
    const jre = path.join(programFiles, 'Eclipse Adoptium', 'jre-21.0.12');
    assert.ok(jdkProblem({ ProgramFiles: programFiles, JAVA_HOME: jre }, 'win32')?.includes(`setx JAVA_HOME "${jdk}"`));
    assert.match(setJavaHomeHint(undefined, 'win32'), /winget install Microsoft\.OpenJDK\.17/);
    assert.match(setJavaHomeHint('/usr/lib/jvm/java-17', 'linux'), /export JAVA_HOME="\/usr\/lib\/jvm\/java-17"/);
  });

  it('mk build --local --dry-run stops on a JRE or a JDK 21, before prebuild', () => {
    const f = makeFixture({ easJson: EAS_JSON, withApk: false });
    const jre = f.makeJava('jre-21', '21.0.12', false);
    refuses(f.run(['build', '--local', '--profile', 'preview', '--dry-run'], { JAVA_HOME: jre }), 'a JRE, it has no bin');
    const jdk21 = f.makeJava('jdk-21', '21.0.5', true);
    refuses(f.run(['build', '--local', '--profile', 'preview', '--dry-run'], { JAVA_HOME: jdk21 }), 'the Android build needs JDK 17');
    refuses(f.run(['build', '--local', '--profile', 'preview', '--dry-run'], { JAVA_HOME: undefined }), 'JAVA_HOME is not set');
    assert.doesNotMatch(f.calls(), /^expo /m);
    const ok = f.run(['build', '--local', '--profile', 'preview', '--dry-run']);
    assert.equal(ok.status, 0, ok.out);
    assert.ok(ok.out.includes(`JDK: ${f.jdkHome}`));
  });
});

// --- 2. Gradle failure cause --------------------------------------------------------

describe('why Gradle failed', () => {
  it('no javac, wrong JDK, heap, Metaspace, or Gradle’s own words', () => {
    assert.equal(gradleFailure("Toolchain installation 'C:\\jre-21' does not provide the required capabilities: [JAVA_COMPILER]").kind, 'no-javac');
    assert.equal(gradleFailure('> Android Gradle plugin requires Java 17 to run. You are currently using Java 11.').kind, 'jdk-version');
    assert.equal(gradleFailure('error: invalid source release: 17').kind, 'jdk-version');
    const heap = gradleFailure('> java.lang.OutOfMemoryError: Java heap space');
    assert.equal(heap.kind, 'out-of-memory');
    assert.match(heap.cause, /ran out of memory/);
    assert.match(gradleFailure('java.lang.OutOfMemoryError: Metaspace').cause, /Metaspace/);
    const out = 'FAILURE: Build failed with an exception.\n\n* What went wrong:\nExecution failed for task \':app:mergeReleaseResources\'.\n> Resource compilation failed\n\n* Try:\n> Run with --stacktrace';
    assert.equal(whatWentWrong(out), "Execution failed for task ':app:mergeReleaseResources'. > Resource compilation failed");
    const other = gradleFailure(out);
    assert.equal(other.kind, 'other');
    assert.match(other.cause, /^Gradle says: Execution failed/);
    assert.match(gradleFailure('').cause, /without saying why/);
    for (const text of ['', out, 'error: invalid source release: 17']) assert.doesNotMatch(gradleFailure(text).cause, /Out of memory\?/);
  });

  it('mk build --local names the cause read from Gradle’s output, not "Out of memory?"', () => {
    const f = makeFixture({ easJson: EAS_JSON, withApk: false });
    const javac = f.run(['build', '--local', '--profile', 'preview'], {
      FAKE_FAIL: 'gradle',
      FAKE_GRADLE_OUTPUT: '> Could not find tools.jar. Please check that C:\\jre contains a valid JDK installation.\n',
    });
    refuses(javac, 'Probable cause: Gradle found no Java compiler');
    assert.ok(javac.out.includes('Seen in the output: > Could not find tools.jar'));
    assert.doesNotMatch(javac.out, /Out of memory\?/);
    const heap = f.run(['build', '--local', '--profile', 'preview'], { FAKE_FAIL: 'gradle', FAKE_GRADLE_OUTPUT: 'java.lang.OutOfMemoryError: Java heap space\n' });
    refuses(heap, 'Gradle ran out of memory');
    const other = f.run(['build', '--local', '--profile', 'preview'], {
      FAKE_FAIL: 'gradle',
      FAKE_GRADLE_OUTPUT: "* What went wrong:\nExecution failed for task ':app:lintVitalRelease'.\n\n* Try:\n",
    });
    refuses(other, "Gradle says: Execution failed for task ':app:lintVitalRelease'.");
    // Gradle's output is still shown live.
    assert.ok(other.out.includes('* What went wrong:'));
    assert.ok(!fs.existsSync(path.join(f.root, 'android')));
  });
});

// --- 3. "Process system isn't responding" -------------------------------------------

describe('Android’s own ANR dialog', () => {
  it('is told apart from apps', () => {
    assert.ok(isSystemAnr('system'));
    assert.ok(isSystemAnr('android'));
    assert.ok(!isSystemAnr('com.google.android.apps.nexuslauncher'));
  });

  it('Wait is tapped and counted; past 3 the run stops with "saturated", restores the device, keeps a report', () => {
    const f = makeFixture();
    const r = qa(f, [...apkArgs(f), '--yes', '--no-open'], { FAKE_SYSTEM_ANR: '1', FAKE_NIGHT: 'auto' });
    refuses(r, 'saturated');
    assert.ok(r.out.includes('stopped responding 4 times'));
    const html = report(f);
    assert.ok(html.includes('class="incomplete warning">Device saturated'));
    assert.ok(html.includes('Process system isn&#39;t responding'));
    assert.equal([...f.calls().matchAll(/shell input tap 540 1368/g)].length, 4);
    assert.equal(f.state().night, 'auto');
    // Stopped: the remaining screenshots never ran.
    assert.ok(html.includes('Not captured'));
  });

  it('three of them are notes, not a stop', () => {
    const f = makeFixture({ smoke: { '01-a.yaml': 'appId: ${APP_ID}\n---\n- launchApp\n' }, config: { screens: ['home'], modes: ['light'] } });
    f.setState({ anr: 'system' });
    const r = qa(f, [...apkArgs(f), '--yes', '--no-open']);
    assert.equal(r.status, 0, r.out);
    assert.ok(report(f).includes('Android&#39;s system process (&quot;Process system isn&#39;t responding&quot;) was not responding: tapped Wait'));
  });
});

// --- 4. Known device state --------------------------------------------------------------

describe('the device starts in a known state and gets its settings back', () => {
  it('a phone: night no, font 1.0, animations off before the flows; its own values after', () => {
    const f = makeFixture({ config: { screens: ['home'], modes: ['light'] } });
    f.setState({ global: { window_animation_scale: '0.5' } });
    const r = qa(f, [...apkArgs(f), '--yes', '--no-open'], { FAKE_NIGHT: 'yes', FAKE_FONT_SCALE: '1.3' });
    assert.equal(r.status, 0, r.out);
    const calls = f.calls();
    const firstFlow = calls.indexOf('maestro --device EMU1 test');
    const before = calls.slice(0, firstFlow);
    assert.match(before, /uimode night no/);
    assert.match(before, /settings put system font_scale 1\.0/);
    for (const k of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
      assert.match(before, new RegExp(`settings put global ${k} 0`));
    }
    const s = f.state() as unknown as { night: string; font_scale: string; global: Record<string, string> };
    assert.equal(s.night, 'yes');
    assert.equal(s.font_scale, '1.3');
    assert.deepEqual(s.global, { window_animation_scale: '0.5' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(captureDir(f), 'results.json'), 'utf8')).saved.animations, ['0.5', 'null', 'null']);
  });

  it('the emulator goes back to the known state, not to what a killed run left (font 1.3, dark)', () => {
    const f = makeFixture();
    f.setState({ night: 'yes', font_scale: '1.3' });
    const r = f.run(['qa:device', '--emulator', ...apkArgs(f), '--yes', '--no-open', '--keep-emulator']);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('Emulator settings at the end (known state): night mode no, font_scale 1.0, animations 0/0/0'));
    const s = f.state();
    assert.equal(s.night, 'no');
    assert.equal(s.font_scale, '1.0');
  });

  it('a dark batch switches night mode back off when it is done', () => {
    const f = makeFixture({ config: { screens: ['home'], modes: ['dark', 'light'] } });
    const r = qa(f, [...apkArgs(f), '--yes', '--no-open']);
    assert.equal(r.status, 0, r.out);
    const nights = [...f.calls().matchAll(/uimode night (yes|no)$/gm)].map((m) => m[1]);
    // known state, dark batch, back off, light batch, restore.
    assert.deepEqual(nights, ['no', 'yes', 'no', 'no', 'no']);
  });
});

// --- 5. Software rendering --------------------------------------------------------------

describe('SwiftShader although gpu=host', () => {
  it('only a GPU mode that renders in software is a warning', () => {
    const sw = 'Google (Google Inc.), Android Emulator OpenGL ES Translator (Google SwiftShader), OpenGL ES 3.0';
    assert.ok(isSoftwareRenderer(sw));
    assert.match(softwareRenderingWarning('host', sw) ?? '', /SOFTWARE RENDERING: gpu=host was requested/);
    assert.equal(softwareRenderingWarning('swiftshader_indirect', sw), null);
    assert.equal(softwareRenderingWarning('host', 'Google (NVIDIA Corporation), … (NVIDIA GeForce GTX 1060/PCIe/SSE2)'), null);
    assert.equal(softwareRenderingWarning('host', null), null);
  });

  it('mk emulator warns in the console; with a working GPU it prints the renderer only', () => {
    const f = makeFixture();
    const good = f.run(['emulator']);
    assert.equal(good.status, 0, good.out);
    assert.ok(good.out.includes('Renderer: Google (NVIDIA Corporation)'));
    assert.ok(!good.out.includes('SOFTWARE RENDERING'));
    const g = makeFixture();
    const bad = g.run(['emulator'], { FAKE_SOFTWARE_RENDER: '1' });
    assert.equal(bad.status, 0, bad.out);
    assert.ok(bad.out.includes('WARNING: SOFTWARE RENDERING: gpu=host was requested'));
  });

  it('qa:device --emulator puts it in the console and on top of report.html', () => {
    const f = makeFixture();
    const r = f.run(['qa:device', '--emulator', ...apkArgs(f), '--yes', '--no-open'], { FAKE_SOFTWARE_RENDER: '1' });
    assert.equal(r.status, 0, r.out);
    // At the boot, and again with the report path at the end.
    assert.ok([...r.out.matchAll(/WARNING: SOFTWARE RENDERING/g)].length >= 2);
    const html = report(f);
    assert.ok(html.includes('<p class="incomplete warning">SOFTWARE RENDERING: gpu=host was requested'));
    assert.ok(html.indexOf('SOFTWARE RENDERING') < html.indexOf('<h2>Maestro smoke flows</h2>'));
    assert.equal([...html.matchAll(/SOFTWARE RENDERING/g)].length, 1);
  });
});

// --- 6. --resume --retry-failed ------------------------------------------------------------

describe('--resume --retry-failed', () => {
  it('keeps every earlier smoke result by default, only the passed ones with --retry-failed', () => {
    const results = [
      { flow: 'smoke/01.yaml', ok: true, seconds: 1 },
      { flow: 'smoke/02.yaml', ok: false, seconds: 1 },
    ];
    assert.equal(keptSmoke(results, false).length, 2);
    assert.deepEqual(keptSmoke(results, true).map((f) => f.flow), ['smoke/01.yaml']);
    assert.throws(() => parseQaArgs(['--retry-failed']), /--retry-failed goes with --resume/);
  });

  it('reruns the smoke flows that failed, and only those', () => {
    const f = makeFixture();
    const first = qa(f, [...apkArgs(f), '--yes', '--no-open'], { FAKE_FAIL: 'maestro:02-add' });
    assert.notEqual(first.status, 0);
    const dir = captureDir(f);
    f.resetCalls();
    const plain = qa(f, ['--resume', dir, '--yes', '--no-open']);
    assert.notEqual(plain.status, 0, 'without --retry-failed the failure stays');
    assert.doesNotMatch(f.calls(), /02-add\.yaml/);
    f.resetCalls();
    const r = qa(f, ['--resume', dir, '--retry-failed', '--yes', '--no-open']);
    assert.equal(r.status, 0, r.out);
    const flows = [...f.calls().matchAll(/^maestro .* test (\S+)/gm)].map((m) => path.basename(m[1]!));
    assert.deepEqual(flows, ['02-add.yaml']);
    const html = report(f);
    assert.ok(html.includes('Smoke: 2/2 passed'));
    assert.ok(html.includes('1 failed smoke flow(s) run again (--retry-failed)'));
  });
});

// --- 7. The guard ----------------------------------------------------------------------------

describe('the guard of a qa:device run', () => {
  const procs: Proc[] = [
    { pid: 10, ppid: 4, name: 'explorer.exe', created: 1000 },
    { pid: 20, ppid: 10, name: 'bash.exe', created: 2000 },
    { pid: 30, ppid: 20, name: 'node.exe', created: 3000 }, // mk
    { pid: 40, ppid: 30, name: 'java.exe', created: 4000 }, // Maestro
    { pid: 41, ppid: 40, name: 'adb.exe', created: 4100 },
    { pid: 50, ppid: 30, name: 'qemu-system-x86_64.exe', created: 5000 },
    // pid 30 reused: started before "its parent", so not mk's child.
    { pid: 60, ppid: 30, name: 'other.exe', created: 500 },
  ];

  it('finds what descends from mk (deepest last) and what mk descends from', () => {
    assert.deepEqual(descendants(procs, { pid: 30, created: 3000 }).map((p) => p.pid), [40, 50, 41]);
    assert.deepEqual(ancestors(procs, 30).map((p) => p.pid), [20, 10]);
    assert.equal(etimeSeconds('1-02:03:04'), 93784);
    assert.equal(etimeSeconds('05:06'), 306);
  });

  it('decides each poll: exit when mk is done, clean up when it died, stop it when its parent died', () => {
    const base = { stateFile: true, mkAlive: true, ancestorsAlive: true, orphanedFor: null, graceMs: 1000 };
    assert.equal(guardStep({ ...base, stateFile: false }), 'exit');
    assert.equal(guardStep(base), 'wait');
    assert.equal(guardStep({ ...base, mkAlive: false }), 'cleanup');
    assert.equal(guardStep({ ...base, ancestorsAlive: false }), 'orphaned');
    assert.equal(guardStep({ ...base, ancestorsAlive: false, orphanedFor: 500 }), 'wait');
    assert.equal(guardStep({ ...base, ancestorsAlive: false, orphanedFor: 1500 }), 'kill');
  });

  it('qa:device starts it and removes its state file at the end; a dry run starts none', () => {
    const f = makeFixture();
    const r = qa(f, [...apkArgs(f), '--yes', '--no-open']);
    assert.equal(r.status, 0, r.out);
    const m = /^procs guard (\S+)$/m.exec(f.calls());
    assert.ok(m, f.calls());
    assert.ok(!fs.existsSync(m[1]!), 'state file removed');
    f.resetCalls();
    qa(f, ['--dry-run']);
    assert.doesNotMatch(f.calls(), /^procs guard/m);
  });

  /**
   * A shell (A) that started mk (M), which started a process (C): real
   * processes, the real guard. Windows' Node kills its non-detached children
   * when it dies (a job object), and bash, which Claude Code killed, does
   * not: so M and C are detached, as the emulator mk starts is.
   */
  async function tree(dir: string) {
    const pids = path.join(dir, 'pids.json');
    const detached = `{ stdio: 'ignore', detached: true }`;
    const child = `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], ${detached})`;
    const mk = `const c = ${child}; require('fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ m: process.pid, c: c.pid })); setInterval(() => {}, 1000)`;
    const shell = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(mk)}], ${detached}); setInterval(() => {}, 1000)`], {
      stdio: 'ignore',
    });
    for (let i = 0; i < 200 && !fs.existsSync(pids); i++) await sleep(50);
    await sleep(100);
    const { m, c } = JSON.parse(fs.readFileSync(pids, 'utf8')) as { m: number; c: number };
    return { shell, m, c };
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  async function until(what: string, ok: () => boolean, ms = 60_000) {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for: ${what}`);
      await sleep(100);
    }
  }
  function startGuard(dir: string, mkPid: number) {
    const state = path.join(dir, 'guard.json');
    const flag = path.join(dir, 'guard.orphaned');
    fs.writeFileSync(
      state,
      JSON.stringify({ mkPid, mkStarted: Date.now() - 60_000, serial: 'emulator-59999', avd: 'mk-test-none', ownsEmulator: false, keepEmulator: false, adb: [], orphanFlag: flag }),
    );
    const r = spawnSync(process.execPath, [path.join(KIT, 'dist', 'procs.js'), 'guard', state], {
      encoding: 'utf8',
      env: { ...process.env, MK_GUARD_POLL_MS: '100', MK_GUARD_GRACE_MS: '1500' },
      timeout: 20_000,
    });
    assert.equal(r.status, 0, r.stderr);
    return { state, flag };
  }

  it('real processes: the shell that started mk is killed → flag, Maestro killed, then mk after the grace period', { timeout: 120_000 }, async () => {
    const dir = tmp();
    const t = await tree(dir);
    try {
      const g = startGuard(dir, t.m);
      // The guard reads mk's ancestors when it starts.
      await sleep(process.platform === 'win32' ? 6000 : 1000);
      assert.ok(alive(t.m) && alive(t.c));
      t.shell.kill('SIGKILL');
      await until('the orphan flag', () => fs.existsSync(g.flag));
      await until('Maestro (mk’s child) killed', () => !alive(t.c));
      assert.ok(alive(t.m), 'mk gets its grace period to restore the device');
      await until('mk killed after the grace period', () => !alive(t.m));
      await until('state file removed', () => !fs.existsSync(g.state));
    } finally {
      for (const pid of [t.c, t.m]) if (alive(pid)) process.kill(pid, 'SIGKILL');
      t.shell.kill('SIGKILL');
    }
  });

  it('real processes: mk killed outright → the guard kills what it left (Windows keeps the parent pid)', { timeout: 120_000, skip: process.platform !== 'win32' }, async () => {
    const dir = tmp();
    const t = await tree(dir);
    try {
      const g = startGuard(dir, t.m);
      await sleep(6000);
      process.kill(t.m, 'SIGKILL');
      await until('Maestro killed', () => !alive(t.c));
      await until('state file removed', () => !fs.existsSync(g.state));
      assert.ok(!fs.existsSync(g.flag));
    } finally {
      for (const pid of [t.c, t.m]) if (alive(pid)) process.kill(pid, 'SIGKILL');
      t.shell.kill('SIGKILL');
    }
  });

  it('mk finished normally (state file gone) → the guard exits and kills nothing', { timeout: 120_000 }, async () => {
    const dir = tmp();
    const t = await tree(dir);
    try {
      const g = startGuard(dir, t.m);
      fs.rmSync(g.state);
      await sleep(3000);
      assert.ok(alive(t.m) && alive(t.c));
    } finally {
      for (const pid of [t.c, t.m]) if (alive(pid)) process.kill(pid, 'SIGKILL');
      t.shell.kill('SIGKILL');
    }
  });
});

// --- B2. --migration-from ------------------------------------------------------------------------

describe('qa:device --migration-from <old apk>', () => {
  const OLD = 'ExampleApp-0.1.0.apk';
  const migrationFixture = () => {
    const f = makeFixture({ config: { screens: ['home'], modes: ['light'] } });
    f.write(`dist/${OLD}`, 'PK\x03\x04....AndroidManifest.xml....');
    f.write('.maestro/migration/seed.yaml', 'appId: ${APP_ID}\n---\n- launchApp\n');
    f.write('.maestro/migration/verify-upgrade.yaml', 'appId: ${APP_ID}\n---\n- launchApp\n');
    return f;
  };
  const oldArgs = (f: Fixture) => ['--migration-from', path.join(f.root, 'dist', OLD)];
  const env = { FAKE_OLD_APK: `${OLD}:12` };

  it('uninstalls, installs the old APK, seeds it, upgrades with -r, verifies, then the smoke flows', () => {
    const f = migrationFixture();
    const r = qa(f, [...apkArgs(f), ...oldArgs(f), '--yes', '--no-open'], env);
    assert.equal(r.status, 0, r.out);
    const steps = f
      .calls()
      .split('\n')
      .filter((l) => / (un)?install /.test(l) || /^maestro .* test /.test(l))
      .map((l) => l.replace(/\\/g, '/').replace(/^(\w+) .*?(uninstall|install(?: -r)?|test) (\S+).*$/, '$1 $2 $3').replace(/\S+\/(?=[^/\s]+$)/, ''));
    assert.deepEqual(steps, [
      'adb uninstall com.example.app',
      `adb install ${OLD}`,
      'maestro test seed.yaml',
      'adb install -r ExampleApp-0.2.0.apk',
      'maestro test verify-upgrade.yaml',
      'maestro test 01-onboarding.yaml',
      'maestro test 02-add.yaml',
      'maestro test home.yaml',
    ]);
    assert.ok(r.out.includes('Old version installed: versionCode 12'));
    const html = report(f);
    assert.ok(html.includes(`Migration from ${OLD} (versionCode 12)`));
    assert.ok(html.includes('Migration: passed'));
    assert.ok(html.includes('migration/verify-upgrade.yaml'));
  });

  it('asks first: the uninstall wipes the data', () => {
    const f = migrationFixture();
    const r = qa(f, [...apkArgs(f), ...oldArgs(f)], env, '');
    refuses(r, '--migration-from (uninstalls ExampleApp), 01-onboarding.yaml CLEAR ExampleApp');
    assert.deepEqual(sideEffects(f.calls()), []);
  });

  it('a failed verify fails the run; a failed seed skips the verify', () => {
    const f = migrationFixture();
    const r = qa(f, [...apkArgs(f), ...oldArgs(f), '--yes', '--no-open'], { ...env, FAKE_FAIL: 'maestro:verify-upgrade' });
    refuses(r, 'QA: the migration test failed');
    assert.ok(report(f).includes('Migration: FAILED'));
    const g = migrationFixture();
    const s = qa(g, [...apkArgs(g), ...oldArgs(g), '--yes', '--no-open'], { ...env, FAKE_FAIL: 'maestro:seed' });
    refuses(s, 'the migration test failed');
    assert.doesNotMatch(g.calls(), /verify-upgrade/);
    assert.ok(report(g).includes('the upgrade is not verified'));
  });

  it('refuses a missing flow, an APK that is not older, and --skip-build / --resume', () => {
    const f = migrationFixture();
    fs.rmSync(path.join(f.root, '.maestro', 'migration', 'seed.yaml'));
    refuses(qa(f, [...apkArgs(f), ...oldArgs(f), '--dry-run'], env), '--migration-from needs .maestro/migration/seed.yaml');
    const g = migrationFixture();
    refuses(qa(g, [...apkArgs(g), ...oldArgs(g), '--dry-run'], { FAKE_OLD_APK: `${OLD}:16` }), 'not older than the APK under test (16)');
    refuses(qa(g, ['--skip-build', ...oldArgs(g), '--dry-run'], env), 'not with --skip-build or --resume');
    assert.deepEqual(sideEffects(g.calls()), []);
  });

  it('--dry-run prints the uninstall, both installs and both flows, runs none', () => {
    const f = migrationFixture();
    const r = qa(f, [...apkArgs(f), ...oldArgs(f), '--dry-run'], env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /not executed\].*adb -s EMU1 uninstall com\.example\.app/);
    assert.match(r.out, /not executed\].*adb -s EMU1 install \S*ExampleApp-0\.1\.0\.apk/);
    assert.match(r.out, /not executed\].*maestro --device EMU1 test \S*seed\.yaml/);
    assert.match(r.out, /not executed\].*maestro --device EMU1 test \S*verify-upgrade\.yaml/);
    assert.deepEqual(sideEffects(f.calls()), []);
  });
});
