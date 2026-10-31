// mk qa:device [--apk <path>] [--skip-build] [--local-build] [--emulator]
//              [--resume <dir> [--retry-failed]] [--migration-from <old apk>]
//              [--keep-emulator] [--yes] [--no-open] [--dry-run]
//
// Device QA on the one connected phone or emulator (--emulator: the local
// emulator, started if needed; refused while a physical phone is connected):
//   1. the screenshot plan is printed first (key screens: every mode ×
//      language × font scale; the others light/dark, first language, 1.0);
//   2. APK: --apk, else an EAS build of the "qa" profile (--local-build:
//      built on this computer with the production key, BEFORE the emulator
//      starts, so the two never share the RAM; --skip-build or --resume: no
//      build and no install, test what is installed);
//   3. a guard process (guard.ts) watches the run from here: if mk, or the
//      terminal or shell that started it, is killed, it kills what mk
//      started (Maestro, adb sessions, the emulator mk booted);
//   4. the device in a known state: night mode no, font_scale 1.0,
//      animations off (dark screenshots switch night mode on, then back);
//   5. --migration-from <old apk>: the app is uninstalled (its data goes),
//      the old APK installed, <maestroDir>/migration/seed.yaml creates data
//      on it; the APK under test is then installed over it (step 6) and
//      <maestroDir>/migration/verify-upgrade.yaml checks the data survived;
//   6. adb install -r, then the installed versionCode must be the expected
//      one: app.json's when the app pins it; otherwise (EAS numbers the
//      builds) the APK's own (aapt2, cross-checked with EAS's
//      appBuildVersion when mk built it), the latest EAS build of the qa
//      profile with --skip-build, or the resumed run's with --resume;
//   7. Maestro smoke flows (<maestroDir>/smoke/*.yaml, in name order);
//   8. screenshots in batches of one device setting, captured with adb
//      screencap. With --emulator, the emulator is cold-restarted before
//      each batch, and mid-batch when host memory runs low; after each
//      boot, a Maestro health check (`maestro hierarchy`), and one driver
//      reinstall if it fails. A batch with 2+ failed screenshots runs
//      once more (after a cold restart on the emulator);
//   9. "isn't responding" dialogs of other apps get Wait tapped; Android's
//      own ("Process system isn't responding") too, and they are counted:
//      past EMULATOR_SATURATED_AFTER of them the run stops (the device is
//      saturated, every later flow would fail). Software rendering
//      (SwiftShader) although a GPU mode was asked for is a warning on top
//      of the report;
//  10. the device's night mode, font scale, animations and app language
//      are restored, also on failure or Ctrl+C (a second Ctrl+C kills
//      everything at once). On the emulator they go back to the known
//      state of step 4, never to what an earlier killed run left;
//  11. .images/captures/<date>-v<version>/ holds results.json and
//      report.html, rewritten after every step: a killed run still leaves
//      a report, and --resume <dir> continues it (--retry-failed: its
//      failed smoke flows run again too). Each failed flow's Maestro debug
//      folder is copied into debug/<name>/.
//
// --dry-run reads the device and prints every change, build, install and
// flow instead of running it.
import fs from 'node:fs';
import path from 'node:path';
import { ANIMATION_SETTINGS, deviceInfo, dismissForeignAnr, getAnimationScales, getAppLocales, getFontScale, getNightMode, installedVersionCode, listDevices, requireOneDevice, screencap, setAnimationArgs, setAppLocalesArgs, setFontScaleArgs, shellAct, } from '../android.js';
import { isApk, readBadging } from '../apk.js';
import { localBuild, localBuildPath } from '../build/local.js';
import { easBuild, latestBuildVersion } from '../eas.js';
import { ensureEmulator, isEmulatorSerial, stopEmulator } from '../emulator.js';
import { act, run } from '../exec.js';
import { hostMemory, killChildren, killEmulatorProcesses, killLeftoverMaestro, memoryPressure, startGuard } from '../host.js';
import { detail, fail, info, KitError, warn } from '../log.js';
import { openProject } from '../project.js';
import { confirm } from '../prompt.js';
import { parseMaestroOutput } from './maestro-output.js';
import { buildPlan, settingLabel, shotKey, shotName } from './plan.js';
import { renderReport, scaleLabel } from './report.js';
export const QA_USAGE = 'Usage: mk qa:device [--apk <path>] [--skip-build] [--local-build] [--emulator] [--resume <dir> [--retry-failed]] ' +
    '[--migration-from <old apk>] [--keep-emulator] [--yes] [--no-open] [--dry-run]';
/** "Process system isn't responding" more than this many times: the device is saturated, the run stops. */
export const EMULATOR_SATURATED_AFTER = 3;
/** The state every run starts from (step 4); the emulator goes back to it at the end. */
export const KNOWN_STATE = { night: 'no', fontScale: '1.0', animations: ANIMATION_SETTINGS.map(() => '0') };
/** --migration-from: its two flows, relative to maestroDir. */
export const MIGRATION_FLOWS = { seed: 'migration/seed.yaml', verify: 'migration/verify-upgrade.yaml' };
export function parseQaArgs(args) {
    const o = {
        skipBuild: false,
        localBuild: false,
        emulator: false,
        retryFailed: false,
        keepEmulator: false,
        yes: false,
        open: true,
        dryRun: false,
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--apk' || a === '--resume' || a === '--migration-from') {
            const value = args[++i];
            if (!value)
                fail(`${a} needs a path. ${QA_USAGE}`);
            if (a === '--apk')
                o.apk = value;
            else if (a === '--resume')
                o.resume = value;
            else
                o.migrationFrom = value;
        }
        else if (a === '--skip-build')
            o.skipBuild = true;
        else if (a === '--retry-failed')
            o.retryFailed = true;
        else if (a === '--local-build')
            o.localBuild = true;
        else if (a === '--emulator')
            o.emulator = true;
        else if (a === '--keep-emulator')
            o.keepEmulator = true;
        else if (a === '--yes')
            o.yes = true;
        else if (a === '--no-open')
            o.open = false;
        else if (a === '--dry-run')
            o.dryRun = true;
        else
            fail(`Unknown option: ${a}. ${QA_USAGE}`);
    }
    if (o.localBuild && (o.apk || o.skipBuild || o.resume)) {
        fail(`--local-build builds a new APK: it cannot go with --apk, --skip-build or --resume. ${QA_USAGE}`);
    }
    if (o.retryFailed && !o.resume)
        fail(`--retry-failed goes with --resume <dir>: it reruns the failed smoke flows of that run. ${QA_USAGE}`);
    if (o.migrationFrom && (o.skipBuild || o.resume)) {
        fail(`--migration-from installs the APK under test over the old one: not with --skip-build or --resume. ${QA_USAGE}`);
    }
    return o;
}
const yamlFiles = (dir) => fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => /\.ya?ml$/.test(f) && !f.startsWith('_'))
        .sort()
    : [];
/** Ctrl+C (or a terminal closing) sets this; the run stops at the next step and restores the device. */
let interrupted = false;
/** The run's guard: it tells when the process that started mk is gone. */
let guard = null;
async function checkpoint() {
    await new Promise((resolve) => setImmediate(resolve));
    if (interrupted)
        throw new KitError('Interrupted (Ctrl+C)');
    if (guard?.orphaned())
        throw new KitError('The terminal or shell that started mk is gone: stopped');
}
const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function outputDir(root, version) {
    const base = path.join(root, '.images', 'captures', `${today()}-v${version}`);
    let dir = base;
    for (let n = 2; fs.existsSync(dir); n++)
        dir = `${base}-${n}`;
    return dir;
}
/** Maestro's on-device driver: uninstalled, Maestro installs it again on its next run. */
export const MAESTRO_DRIVER = ['dev.mobile.maestro', 'dev.mobile.maestro.test'];
/** A copy of the debug folder Maestro printed, in <outDir>/debug/<name>/: its path relative to the report. */
function keepDebug(ctx, from, name) {
    if (!from || !fs.existsSync(from))
        return undefined;
    const to = path.join(ctx.outDir, 'debug', name);
    try {
        fs.rmSync(to, { recursive: true, force: true });
        fs.cpSync(from, to, { recursive: true });
        return `debug/${name}`;
    }
    catch (e) {
        warn(`Could not copy Maestro's debug folder ${from}: ${e.message}`);
        return undefined;
    }
}
/** Runs a flow; a failure keeps the real error line and a copy of Maestro's debug folder (debug/<debugName>/). */
function maestro(ctx, flowPath, env, logName, debugName = logName) {
    const args = ['--device', ctx.serial, 'test', flowPath, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])];
    const flow = path.relative(ctx.maestroDir, flowPath).replace(/\\/g, '/');
    if (ctx.p.dryRun) {
        act(true, ctx.p.tool.maestro, args);
        return { flow, ok: true, seconds: 0 };
    }
    const started = Date.now();
    // Maestro's JVM writes its crash dumps (hs_err_pid*.log, replay_pid*.log)
    // into its working folder: the capture folder, never the app's root.
    fs.mkdirSync(ctx.outDir, { recursive: true });
    const r = run(ctx.p.tool.maestro, args, { cwd: ctx.outDir });
    const output = `${r.stdout}\n${r.stderr}`.trim();
    fs.mkdirSync(ctx.logDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.logDir, `${logName}.log`), output);
    const seconds = (Date.now() - started) / 1000;
    if (r.status === 0)
        return { flow, ok: true, seconds };
    const parsed = parseMaestroOutput(output);
    const debug = keepDebug(ctx, parsed.debugDir, debugName);
    return {
        flow,
        ok: false,
        seconds,
        error: parsed.text.split('\n').slice(-25).join('\n'),
        ...(parsed.errorLine ? { errorLine: parsed.errorLine } : {}),
        ...(debug ? { debug } : {}),
    };
}
/** `maestro hierarchy` reads the screen through Maestro's driver: it fails when Maestro cannot reach the device. */
function maestroReaches(ctx) {
    const args = ['--device', ctx.serial, 'hierarchy'];
    if (ctx.p.dryRun)
        return act(true, ctx.p.tool.maestro, args).status === 0;
    return run(ctx.p.tool.maestro, args, { cwd: ctx.outDir }).status === 0;
}
/** The run of an earlier invocation, from <dir>/results.json. */
function loadRun(dir) {
    const file = path.join(dir, 'results.json');
    if (!fs.existsSync(file))
        fail(`--resume: no results.json in ${dir}`);
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (e) {
        fail(`--resume: ${file} is not valid JSON: ${e.message}`);
    }
}
/**
 * The versionCode the device must have after the install. app.json's when
 * the app pins one; otherwise the build's: the resumed run's, the APK's
 * (aapt2) checked against EAS's appBuildVersion when mk built it, or the
 * latest finished EAS build of the qa profile (--skip-build).
 */
export function expectedVersionCode(p, o, s) {
    if (p.app.versionCode !== null)
        return { versionCode: p.app.versionCode, from: 'app.json' };
    if (s.previous) {
        if (s.previous.versionCode === null)
            fail('--resume: that run never knew its versionCode (a dry run?). Start a new run instead.');
        return { versionCode: s.previous.versionCode, from: 'the resumed run' };
    }
    if (s.apk && fs.existsSync(s.apk)) {
        const badging = readBadging(s.apk, p.tool.aapt);
        if (!badging) {
            if (s.builtVc !== null)
                return { versionCode: s.builtVc, from: 'the EAS build' };
            fail('This app has no versionCode in app.json (EAS numbers the builds), so mk reads it from the APK, ' +
                'and that needs aapt2: install the Android build-tools or set ANDROID_HOME.');
        }
        if (badging.androidPackage !== p.config.androidPackage) {
            fail(`${path.basename(s.apk)} is ${badging.androidPackage}, not ${p.config.androidPackage}`);
        }
        if (s.builtVc !== null && badging.versionCode !== s.builtVc) {
            fail(`The downloaded APK has versionCode ${badging.versionCode}, but EAS built ${s.builtVc}: not the build that just ran.`);
        }
        return { versionCode: badging.versionCode, from: s.builtVc !== null ? 'the EAS build' : 'the APK' };
    }
    if (s.builtVc !== null)
        return { versionCode: s.builtVc, from: 'the EAS build' };
    if (o.skipBuild) {
        const profile = p.config.easProfiles.qa;
        return { versionCode: latestBuildVersion(p, profile), from: `the latest EAS ${profile} build` };
    }
    return { versionCode: null, from: 'EAS numbers the builds and nothing was built on this dry run' };
}
/** The smoke results a resumed run keeps: all of them, or only the passed ones with --retry-failed. */
export function keptSmoke(previous, retryFailed) {
    return retryFailed ? previous.filter((f) => f.ok) : previous;
}
/** The old APK of --migration-from: an APK of this app, older than the one under test; its versionCode when aapt2 reads it. */
function checkOldApk(p, apk, expected) {
    if (!isApk(apk))
        fail(`--migration-from: not an APK: ${apk}`);
    const badging = readBadging(apk, p.tool.aapt);
    if (!badging) {
        warn(`--migration-from: cannot read ${path.basename(apk)} (no aapt2): its package and versionCode are not checked`);
        return null;
    }
    if (badging.androidPackage !== p.config.androidPackage) {
        fail(`--migration-from: ${path.basename(apk)} is ${badging.androidPackage}, not ${p.config.androidPackage}`);
    }
    if (expected !== null && badging.versionCode >= expected) {
        fail(`--migration-from: ${path.basename(apk)} has versionCode ${badging.versionCode}, not older than the APK under test (${expected})`);
    }
    return badging.versionCode;
}
export async function qaDevice(args) {
    const o = parseQaArgs(args);
    const p = openProject({ dryRun: o.dryRun, requireDryRunInFixture: false });
    const { config, app } = p;
    const maestroDir = path.join(p.root, config.maestroDir);
    // --- Flows ---------------------------------------------------------------
    const smoke = yamlFiles(path.join(maestroDir, 'smoke')).map((f) => path.join(maestroDir, 'smoke', f));
    if (smoke.length === 0)
        warn(`No smoke flows in ${config.maestroDir}/smoke/`);
    const screenFiles = new Map(config.screens.map(({ name }) => {
        const file = path.join(maestroDir, 'screens', `${name}.yaml`);
        if (!fs.existsSync(file))
            fail(`Screen flow missing: ${config.maestroDir}/screens/${name}.yaml (mobile-kit.config.json "screens")`);
        return [name, file];
    }));
    const langFlow = config.languages.method === 'flow' ? path.join(maestroDir, config.languages.flow ?? '') : null;
    if (langFlow && !fs.existsSync(langFlow))
        fail(`Language flow missing: ${config.maestroDir}/${config.languages.flow}`);
    const migrationApk = o.migrationFrom ? path.resolve(o.migrationFrom) : null;
    const migrationFlows = { seed: path.join(maestroDir, MIGRATION_FLOWS.seed), verify: path.join(maestroDir, MIGRATION_FLOWS.verify) };
    if (migrationApk) {
        for (const f of Object.values(MIGRATION_FLOWS)) {
            if (!fs.existsSync(path.join(maestroDir, f)))
                fail(`--migration-from needs ${config.maestroDir}/${f}`);
        }
    }
    // --- The plan, first -----------------------------------------------------
    let plan = buildPlan(config.screens, config.modes, config.languages.codes, config.fontScales);
    info(`Screenshots: ${plan.summary}`);
    // --- Earlier run (--resume) ----------------------------------------------
    let previous = null;
    let outDir;
    if (o.resume) {
        outDir = path.resolve(o.resume);
        previous = loadRun(outDir);
        // With EAS numbering, app.json has no versionCode: the run's own is
        // checked against the device below.
        const vcDiffers = app.versionCode !== null && previous.versionCode !== app.versionCode;
        if (previous.androidPackage !== config.androidPackage || previous.version !== app.version || vcDiffers) {
            const appVc = app.versionCode !== null ? ` (versionCode ${app.versionCode})` : '';
            fail(`--resume: that run tested ${previous.androidPackage} ${previous.version} (versionCode ${previous.versionCode ?? 'unknown'}); ` +
                `app.json is ${app.version}${appVc}. Start a new run instead.`);
        }
        info(`Resuming ${outDir}`);
    }
    else
        outDir = outputDir(p.root, app.version);
    // --- Local build, before any emulator runs (they would share the RAM) -----
    let localApk = null;
    if (o.localBuild) {
        const built = await localBuild(p, config.easProfiles.qa);
        localApk = built.built || p.dryRun ? built.apk : null;
    }
    // --- From here a guard cleans up if mk (or what started it) is killed -----
    guard = startGuard(p, { serial: null, ownsEmulator: false, keepEmulator: o.keepEmulator });
    try {
        await runOnDevice({ p, o, smoke, screenFiles, langFlow, migrationApk, migrationFlows, plan, previous, outDir, localApk, maestroDir });
    }
    finally {
        guard.stop();
        guard = null;
    }
}
async function runOnDevice(input) {
    const { p, o, smoke, screenFiles, langFlow, migrationApk, migrationFlows, previous, outDir, localApk, maestroDir } = input;
    const { config, app } = p;
    let plan = input.plan;
    const g = guard;
    /** Bench problems (rendering, saturation): shown on top of the report. */
    const warnings = [...(previous?.warnings ?? [])];
    const benchWarning = (text) => {
        if (!warnings.includes(text))
            warnings.push(text);
    };
    // --- Device --------------------------------------------------------------
    let serial;
    let ownsEmulator = false;
    /** The emulator booted and nothing ran on it yet: no need to restart it. */
    let freshBoot = false;
    let firstBoot = null;
    if (o.emulator) {
        const physical = listDevices(p.tool.adb).ready.filter((d) => !isEmulatorSerial(d));
        if (physical.length) {
            fail(`--emulator, but a physical device is connected: ${physical.join(', ')}. ` +
                'Unplug it (or turn off wireless debugging): QA runs on the emulator only.');
        }
        const ready = await ensureEmulator(p);
        firstBoot = ready;
        ownsEmulator = ready.started;
        freshBoot = ready.started;
        if (ready.softwareRendering)
            benchWarning(ready.softwareRendering);
        serial = p.dryRun && listDevices(p.tool.adb).ready.length === 0 ? ready.serial : requireOneDevice(p.tool.adb);
    }
    else
        serial = requireOneDevice(p.tool.adb);
    g?.update({ serial, ownsEmulator });
    const device = deviceInfo(p.tool.adb, serial);
    info(`Device: ${device.manufacturer} ${device.model}, Android ${device.androidVersion} (API ${device.sdk}), ${serial}`);
    // --- APK -----------------------------------------------------------------
    let apk = null;
    let apkLabel;
    /** EAS's versionCode of the build mk just ran. */
    let builtVc = null;
    if (o.apk) {
        apk = path.resolve(o.apk);
        if (!isApk(apk))
            fail(`Not an APK: ${o.apk}`);
        apkLabel = path.basename(apk);
    }
    else if (o.localBuild) {
        apk = localApk;
        apkLabel = `local ${config.easProfiles.qa} build → ${path.basename(localBuildPath(p, config.easProfiles.qa))}`;
    }
    else if (o.skipBuild || previous) {
        apkLabel = previous?.apk ?? 'already installed (--skip-build)';
    }
    else {
        apk = path.join(p.root, 'dist', `${config.apkName}-${app.version}-qa.apk`);
        apkLabel = `EAS ${config.easProfiles.qa} build → ${path.basename(apk)}`;
        const built = easBuild(p, config.easProfiles.qa, apk);
        builtVc = built.appBuildVersion;
        if (!built.downloaded)
            apk = p.dryRun ? apk : null;
    }
    // --- Expected versionCode -------------------------------------------------
    const expected = expectedVersionCode(p, o, { apk, builtVc, previous });
    if (expected.versionCode !== null)
        info(`Expected versionCode ${expected.versionCode} (${expected.from})`);
    const oldVc = migrationApk ? checkOldApk(p, migrationApk, expected.versionCode) : null;
    // --- Smoke flows still to run; what wipes the app's data asks first -----
    const kept = keptSmoke(previous?.smoke ?? [], o.retryFailed);
    const smokeDone = new Set(kept.map((f) => f.flow));
    const flowName = (file) => path.relative(maestroDir, file).replace(/\\/g, '/');
    const smokeToRun = smoke.filter((f) => !smokeDone.has(flowName(f)));
    const wipes = smokeToRun.filter((f) => /\bclearState\b/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.basename(f));
    if (migrationApk)
        wipes.unshift(`--migration-from (uninstalls ${config.appName})`);
    if (wipes.length) {
        const question = `${wipes.join(', ')} CLEAR ${config.appName}'s data on ${device.model} (${serial}). Continue?`;
        if (p.dryRun)
            detail(`[dry run] would ask: ${question}`);
        else if (!o.yes && !(await confirm(question)))
            fail('Stopped: nothing installed or changed.');
    }
    // --- Maestro runs a killed mk left behind on this device -----------------
    const leftovers = killLeftoverMaestro(p, serial);
    if (leftovers)
        warn(`Stopped ${leftovers} Maestro process(es) left on ${serial} by an earlier run`);
    // --- Languages -----------------------------------------------------------
    const notes = [];
    let languages = config.languages.codes;
    const method = config.languages.method;
    if (method === 'app-locale' && device.sdk < 33) {
        const note = `Per-app language needs Android 13+ (this device: API ${device.sdk}): screenshots in the current language only.`;
        warn(note);
        notes.push(note);
        languages = ['current'];
        plan = buildPlan(config.screens, config.modes, languages, config.fontScales);
        info(`Screenshots: ${plan.summary}`);
    }
    // --- Settings to restore: the phone's own, or the emulator's known state ---
    const appLocalesKnown = method === 'app-locale' && languages[0] !== 'current';
    const saved = previous?.saved ??
        (o.emulator
            ? { night: KNOWN_STATE.night, fontScale: KNOWN_STATE.fontScale, appLocales: appLocalesKnown ? '' : null, animations: [...KNOWN_STATE.animations] }
            : {
                night: getNightMode(p.tool.adb, serial),
                fontScale: getFontScale(p.tool.adb, serial),
                appLocales: appLocalesKnown ? getAppLocales(p.tool.adb, serial, config.androidPackage) : null,
                animations: getAnimationScales(p.tool.adb, serial),
            });
    info(`${previous?.saved ? 'Device settings to restore (from the first run)' : o.emulator ? 'Emulator settings at the end (known state)' : 'Saved device settings'}: ` +
        `night mode ${saved.night}, font_scale ${saved.fontScale}` +
        (saved.animations ? `, animations ${saved.animations.join('/')}` : '') +
        (saved.appLocales !== null ? `, app language ${saved.appLocales || 'system'}` : ''));
    // --- The run, written after every step -----------------------------------
    const ctx = { p, serial, device, maestroDir, outDir, logDir: path.join(outDir, 'logs') };
    const done = new Map((previous?.shots ?? []).filter((s) => s.file).map((s) => [shotKey(s.screen, s), s]));
    const shots = plan.batches.flatMap((b) => b.screens.map((screen) => done.get(shotKey(screen, b)) ?? { screen, mode: b.mode, lang: b.lang, scale: b.scale }));
    const retried = (previous?.smoke.length ?? 0) - kept.length;
    const run_ = {
        appName: config.appName,
        androidPackage: config.androidPackage,
        version: app.version,
        versionCode: expected.versionCode,
        versionCodeFrom: expected.from,
        installedVersionCode: previous?.installedVersionCode ?? null,
        apk: apkLabel,
        device,
        startedAt: previous?.startedAt ?? new Date().toISOString(),
        finishedAt: '',
        outDir,
        plan: plan.summary,
        saved,
        smoke: [...kept],
        shots,
        notes: [
            ...(previous?.notes ?? []),
            ...(previous ? [`Resumed ${new Date().toISOString()}${retried ? `: ${retried} failed smoke flow(s) run again (--retry-failed)` : ''}`] : []),
            ...notes,
        ],
        warnings,
        ...(previous?.migration ? { migration: previous.migration } : {}),
    };
    const persist = () => {
        if (p.dryRun)
            return;
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify(run_, null, 2)}\n`);
        fs.writeFileSync(path.join(outDir, 'report.html'), renderReport(run_));
    };
    const note = (text) => {
        warn(text);
        run_.notes.push(text);
        persist();
    };
    persist();
    /** Android's own ANR dialogs seen in this run (EMULATOR_SATURATED_AFTER). */
    let systemAnrs = 0;
    const onAnr = (a, during = '') => {
        if (!a)
            return;
        note(`${a.note}${during}`);
        if (!a.system)
            return;
        systemAnrs++;
        if (systemAnrs > EMULATOR_SATURATED_AFTER) {
            const why = `${o.emulator ? 'Emulator' : 'Device'} saturated: Android's system process stopped responding ${systemAnrs} times ` +
                `("Process system isn't responding"). The run stopped: every later flow would fail on the device, not on the app. ` +
                (o.emulator
                    ? 'Free host memory (close Brave, Android Studio), check the GPU mode (no SwiftShader), then continue with --resume.'
                    : 'Restart the phone, then continue with --resume.');
            benchWarning(why);
            throw new KitError(why);
        }
    };
    const anrCheck = () => onAnr(dismissForeignAnr(p.dryRun, p.tool.adb, ctx.serial, config.androidPackage));
    if (firstBoot?.anr)
        onAnr(firstBoot.anr, ' (after the boot)');
    const setLanguage = (lang) => {
        if (lang === 'current')
            return;
        if (method === 'app-locale')
            shellAct(p.dryRun, p.tool.adb, ctx.serial, setAppLocalesArgs(config.androidPackage, lang));
        else if (method === 'deep-link') {
            const url = (config.languages.deepLink ?? '').replace('{lang}', lang);
            shellAct(p.dryRun, p.tool.adb, ctx.serial, ['am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', url, config.androidPackage]);
        }
        else if (langFlow) {
            const r = maestro(ctx, langFlow, { APP_ID: config.androidPackage, LANG: lang }, `language-${lang}`);
            if (!r.ok)
                throw new KitError(`Language flow failed for ${lang}: ${r.error ?? ''}`);
        }
    };
    const setNight = (on) => shellAct(p.dryRun, p.tool.adb, ctx.serial, ['cmd', 'uimode', 'night', on ? 'yes' : 'no']);
    const applySetting = (s) => {
        setNight(s.mode === 'dark');
        shellAct(p.dryRun, p.tool.adb, ctx.serial, setFontScaleArgs(s.scale.toFixed(2).replace(/0$/, '')));
        setLanguage(s.lang);
    };
    /** Step 4: whatever an earlier run (or the user) left, every run starts from the same device state. */
    const knownState = () => {
        info(`Known state: night mode ${KNOWN_STATE.night}, font_scale ${KNOWN_STATE.fontScale}, animations off`);
        setNight(false);
        shellAct(p.dryRun, p.tool.adb, ctx.serial, setFontScaleArgs(KNOWN_STATE.fontScale));
        ANIMATION_SETTINGS.forEach((key, i) => shellAct(p.dryRun, p.tool.adb, ctx.serial, setAnimationArgs(key, KNOWN_STATE.animations[i] ?? '0')));
    };
    /**
     * After a boot (ensureEmulator waited for it and unlocked the screen),
     * Maestro must reach the device: after one cold restart its driver was
     * broken for two whole batches. If `maestro hierarchy` fails, the driver
     * is uninstalled (Maestro installs it again) and the check runs once more.
     */
    const healthCheck = () => {
        const left = killLeftoverMaestro(p, ctx.serial);
        if (left)
            note(`Stopped ${left} Maestro process(es) still running on ${ctx.serial} after the boot`);
        info('Maestro health check (maestro hierarchy)');
        if (maestroReaches(ctx))
            return;
        note(`Maestro could not reach ${ctx.serial} after the boot: reinstalling its driver (${MAESTRO_DRIVER.join(', ')})`);
        for (const pkg of MAESTRO_DRIVER)
            act(p.dryRun, p.tool.adb, ['-s', ctx.serial, 'uninstall', pkg]);
        if (maestroReaches(ctx))
            info('Maestro reaches the device again');
        else
            note(`Maestro still cannot reach ${ctx.serial} after reinstalling its driver`);
    };
    /** Emulator only: a cold boot frees the host memory the emulator kept. */
    const restartEmulator = async (why) => {
        info(`Restarting the emulator cold (${why})`);
        const ready = await ensureEmulator(p, { cold: true });
        ctx.serial = ready.serial;
        ownsEmulator = true;
        freshBoot = true;
        g?.update({ serial: ctx.serial, ownsEmulator });
        if (ready.softwareRendering) {
            benchWarning(ready.softwareRendering);
            persist();
        }
        onAnr(ready.anr, ' (after the boot)');
        healthCheck();
    };
    /** Captures `names` with the batch's setting applied; returns how many failed in this attempt. */
    const captureBatch = async (batch, names, attempt) => {
        let failed = 0;
        for (const [j, screen] of names.entries()) {
            await checkpoint();
            anrCheck();
            const name = shotName(screen, batch);
            const shot = shots.find((s) => shotKey(s.screen, s) === shotKey(screen, batch));
            if (!shot)
                throw new KitError(`Internal: ${name} is not in the plan`);
            delete shot.error;
            delete shot.debug;
            const flow = screenFiles.get(screen) ?? '';
            const logName = attempt === 1 ? `screen-${name}` : `screen-${name}-batch-retry`;
            let r = maestro(ctx, flow, { APP_ID: config.androidPackage }, logName, name);
            freshBoot = false;
            // A screen flow only opens a screen: run it again if an
            // "isn't responding" dialog was covering it.
            if (!r.ok && !p.dryRun) {
                const a = dismissForeignAnr(false, p.tool.adb, ctx.serial, config.androidPackage);
                if (a?.tapped) {
                    onAnr(a, ` during ${name}: ran it again`);
                    r = maestro(ctx, flow, { APP_ID: config.androidPackage }, `${logName}-retry`, name);
                }
                else
                    onAnr(a, ` during ${name}`);
            }
            if (p.dryRun) {
                detail(`[dry run, not executed] adb -s ${ctx.serial} exec-out screencap -p > ${name}.png`);
            }
            else if (!r.ok) {
                failed++;
                // A retry that fails keeps the screenshot the first attempt took.
                if (!shot.file) {
                    shot.error = `Flow failed: ${r.errorLine ?? 'see the log'}`;
                    if (r.debug)
                        shot.debug = r.debug;
                }
            }
            else {
                const png = screencap(p.tool.adb, ctx.serial);
                if (png) {
                    fs.writeFileSync(path.join(outDir, `${name}.png`), png);
                    shot.file = `${name}.png`;
                }
                else if (!shot.file) {
                    failed++;
                    shot.error = 'adb screencap returned no PNG';
                }
                else
                    failed++;
            }
            persist();
            if (!p.dryRun) {
                const status = r.ok && shot.file ? 'OK  ' : 'MISS';
                detail(`${status} ${screen} · ${batch.mode} · ${batch.lang} · ${scaleLabel(batch.scale)}${r.ok ? '' : `: ${r.errorLine ?? ''}`}`);
            }
            // Watchdog: the capture is done; restart before the next one if memory is short.
            if (o.emulator && !p.dryRun && j < names.length - 1) {
                const m = hostMemory(p);
                const why = m && memoryPressure(m, config.emulator);
                if (why) {
                    note(`Memory: ${why}: restarted the emulator before ${names[j + 1]} (${settingLabel(batch)})`);
                    await restartEmulator(why);
                    applySetting(batch);
                }
            }
        }
        return failed;
    };
    /** Step 5, first half: the old version with data on it. False when it could not be seeded. */
    const migrationSeed = async (m, oldApk) => {
        info(`Migration: ${path.basename(oldApk)} first, with data, then the APK under test over it`);
        if (act(p.dryRun, p.tool.adb, ['-s', ctx.serial, 'uninstall', config.androidPackage]).status !== 0) {
            detail(`${config.androidPackage} was not installed`);
        }
        if (act(p.dryRun, p.tool.adb, ['-s', ctx.serial, 'install', oldApk]).status !== 0)
            fail(`adb install of ${path.basename(oldApk)} failed`);
        const vc = installedVersionCode(p.tool.adb, ctx.serial, config.androidPackage);
        if (!p.dryRun)
            info(`Old version installed: versionCode ${vc ?? 'none'}`);
        await checkpoint();
        anrCheck();
        detail(`${MIGRATION_FLOWS.seed} …`);
        m.seed = maestro(ctx, migrationFlows.seed, { APP_ID: config.androidPackage }, 'migration-seed');
        persist();
        if (!p.dryRun)
            detail(`${m.seed.ok ? 'PASS' : 'FAIL'} ${m.seed.flow} (${m.seed.seconds.toFixed(1)} s)`);
        if (!m.seed.ok) {
            note(`Migration: ${MIGRATION_FLOWS.seed} failed on ${path.basename(oldApk)}: the upgrade is not verified`);
            return false;
        }
        return true;
    };
    /** A second Ctrl+C does not wait for the step: everything mk started goes now. */
    let signalCount = 0;
    const onSignal = () => {
        interrupted = true;
        signalCount++;
        if (signalCount === 1) {
            warn('Stopping after this step, then restoring the device settings (Ctrl+C again: stop everything now)');
            return;
        }
        warn('Stopping now: killing Maestro, adb and the emulator mk started; the device settings are NOT restored');
        killChildren(p);
        if (ownsEmulator)
            killEmulatorProcesses(p, config.emulator.avd);
        g?.stop();
        process.exit(130);
    };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const s of signals)
        process.on(s, onSignal);
    let stopError = null;
    try {
        if (o.emulator && ownsEmulator)
            healthCheck();
        knownState();
        // Migration, before the install of the APK under test.
        let seeded = false;
        if (migrationApk) {
            const m = { from: path.basename(migrationApk), fromVersionCode: oldVc };
            run_.migration = m;
            seeded = await migrationSeed(m, migrationApk);
        }
        // Install and versionCode.
        if (apk) {
            info(`Installing ${path.basename(apk)} on ${ctx.serial} (adb install -r keeps the data)`);
            if (act(p.dryRun, p.tool.adb, ['-s', ctx.serial, 'install', '-r', apk]).status !== 0) {
                fail(`adb install failed${migrationApk ? ` (over ${path.basename(migrationApk)}: both must be signed with the same key)` : ''}`);
            }
        }
        const installed = installedVersionCode(p.tool.adb, ctx.serial, config.androidPackage);
        run_.installedVersionCode = installed;
        persist();
        if (expected.versionCode === null) {
            warn(`Installed versionCode is ${installed ?? 'none'}; the expected one is unknown (${expected.from}). A real run knows it.`);
        }
        else if (installed !== expected.versionCode) {
            const message = `Installed versionCode is ${installed ?? 'none'}, ${expected.from} says ${expected.versionCode}.`;
            if (p.dryRun)
                warn(`${message} (dry run: nothing was installed; a real run stops here)`);
            else
                fail(`${message} Wrong build on the device: stopped before testing.`);
        }
        else
            info(`Installed versionCode ${installed} = ${expected.from}`);
        // Migration, after the upgrade: the data must still be there.
        if (run_.migration && seeded) {
            await checkpoint();
            anrCheck();
            detail(`${MIGRATION_FLOWS.verify} …`);
            const m = run_.migration;
            m.verify = maestro(ctx, migrationFlows.verify, { APP_ID: config.androidPackage }, 'migration-verify');
            if (!m.verify.ok && m.verify.errorLine)
                detail(m.verify.errorLine);
            persist();
            if (!p.dryRun)
                detail(`${m.verify.ok ? 'PASS' : 'FAIL'} ${m.verify.flow} (${m.verify.seconds.toFixed(1)} s)`);
        }
        // Smoke.
        if (smokeToRun.length)
            info(`Maestro smoke flows (${smokeToRun.length}${smokeDone.size ? `, ${smokeDone.size} done earlier` : ''})`);
        for (const file of smokeToRun) {
            await checkpoint();
            anrCheck();
            detail(`${path.basename(file)} …`);
            const r = maestro(ctx, file, { APP_ID: config.androidPackage }, `smoke-${path.basename(file, path.extname(file))}`);
            if (!r.ok && r.errorLine)
                detail(r.errorLine);
            freshBoot = false;
            run_.smoke.push(r);
            persist();
            if (!p.dryRun)
                detail(`${r.ok ? 'PASS' : 'FAIL'} ${r.flow} (${r.seconds.toFixed(1)} s)`);
            // A dialog that appeared during the flow (and probably failed it).
            if (!r.ok && !p.dryRun)
                onAnr(dismissForeignAnr(false, p.tool.adb, ctx.serial, config.androidPackage), ` during ${r.flow}`);
        }
        // Screenshots, one batch per device setting.
        if (!p.dryRun)
            fs.mkdirSync(outDir, { recursive: true });
        const pending = (b) => b.screens.filter((screen) => !done.has(shotKey(screen, b)));
        const todo = plan.batches.filter((b) => pending(b).length);
        info(`Screenshots: ${todo.length} batch(es) to run${done.size ? `, ${done.size} screenshot(s) kept from the earlier run` : ''}`);
        for (const [i, batch] of todo.entries()) {
            await checkpoint();
            info(`Batch ${i + 1}/${todo.length}: ${settingLabel(batch)}`);
            const names = pending(batch);
            for (let attempt = 1;; attempt++) {
                if (o.emulator && !freshBoot)
                    await restartEmulator(attempt === 1 ? 'one batch per boot' : 'before retrying the batch');
                applySetting(batch);
                const failed = await captureBatch(batch, names, attempt);
                // Two or more failures in one batch point at the device (Maestro
                // lost it), not at the screens: one more go, on a fresh boot.
                if (p.dryRun || failed < 2 || attempt === 2)
                    break;
                note(`${settingLabel(batch)}: ${failed} of ${names.length} screenshots failed: ` +
                    `retrying the whole batch once${o.emulator ? ' after a cold restart' : ''}`);
            }
            // Dark screenshots switched night mode on: back to the known state.
            if (batch.mode === 'dark')
                setNight(false);
        }
    }
    catch (e) {
        stopError = e;
    }
    finally {
        for (const s of signals)
            process.off(s, onSignal);
        restore(ctx, saved, run_);
        run_.finishedAt = new Date().toISOString();
        if (stopError)
            run_.notes.push(`Stopped early: ${stopError.message}`);
        persist();
        const left = killLeftoverMaestro(p, ctx.serial);
        if (left)
            warn(`Stopped ${left} Maestro process(es) still running on ${ctx.serial}`);
        if (o.emulator && ownsEmulator && !o.keepEmulator) {
            info('Stopping the emulator (mk started it; --keep-emulator leaves it running)');
            await stopEmulator(p, ctx.serial).catch((e) => warn(`Could not stop the emulator: ${e.message}`));
        }
    }
    if (p.dryRun) {
        if (stopError)
            throw stopError;
        info('Dry run: no report written');
        return;
    }
    const report = path.join(outDir, 'report.html');
    info(`Report: ${report}`);
    for (const w of warnings)
        warn(w);
    if (o.open)
        run(p.tool.open, [report]);
    if (stopError)
        throw stopError;
    const smokeFailed = run_.smoke.filter((f) => !f.ok).length;
    const missing = run_.shots.filter((s) => !s.file).length;
    const migrationFailed = run_.migration ? !(run_.migration.seed?.ok && run_.migration.verify?.ok) : false;
    if (smokeFailed || missing || migrationFailed) {
        fail(`QA: ${migrationFailed ? 'the migration test failed, ' : ''}${smokeFailed} smoke flow(s) failed, ${missing} screenshot(s) missing. See the report.`);
    }
    info(`QA done: ${run_.migration ? 'the migration test and ' : ''}every smoke flow passed. Now review the screenshots in the report.`);
}
/** Each setting on its own: one failure does not skip the others. */
function restore(ctx, saved, r) {
    const { p, serial } = ctx;
    info('Restoring the device settings');
    const attempt = (what, fn) => {
        try {
            const res = fn();
            if (res && res.status !== 0)
                throw new Error(res.stderr.trim() || `exit ${res.status}`);
        }
        catch (e) {
            const note = `Could not restore ${what}: ${e.message}. Set it back by hand.`;
            warn(note);
            r.notes.push(note);
        }
    };
    attempt('night mode', () => {
        if (!['yes', 'no', 'auto'].includes(saved.night))
            throw new Error(`it was "${saved.night}" (Settings → Display → Dark theme)`);
        return shellAct(p.dryRun, p.tool.adb, serial, ['cmd', 'uimode', 'night', saved.night]);
    });
    attempt('font scale', () => shellAct(p.dryRun, p.tool.adb, serial, setFontScaleArgs(saved.fontScale)));
    // Runs before 0.3.2 did not save them (and did not change them on a phone).
    if (saved.animations) {
        const values = saved.animations;
        ANIMATION_SETTINGS.forEach((key, i) => attempt(key, () => shellAct(p.dryRun, p.tool.adb, serial, setAnimationArgs(key, values[i] ?? 'null'))));
    }
    if (saved.appLocales !== null) {
        const locales = saved.appLocales;
        attempt('app language', () => shellAct(p.dryRun, p.tool.adb, serial, setAppLocalesArgs(p.config.androidPackage, locales)));
    }
    const back = p.config.languages.restore;
    if (back && p.config.languages.method !== 'app-locale') {
        attempt('app language', () => {
            const { method, deepLink } = p.config.languages;
            if (method === 'deep-link') {
                return shellAct(p.dryRun, p.tool.adb, serial, ['am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', (deepLink ?? '').replace('{lang}', back), p.config.androidPackage]);
            }
            else {
                const res = maestro(ctx, path.join(ctx.maestroDir, p.config.languages.flow ?? ''), { APP_ID: p.config.androidPackage, LANG: back }, 'language-restore');
                if (!res.ok)
                    throw new Error('the language flow failed');
            }
        });
    }
}
