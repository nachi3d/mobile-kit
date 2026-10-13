// mk qa:device [--apk <path>] [--skip-build] [--local-build] [--emulator]
//              [--resume <dir>] [--keep-emulator] [--yes] [--no-open] [--dry-run]
//
// Device QA on the one connected phone or emulator (--emulator: the local
// emulator, started if needed; refused while a physical phone is connected):
//   1. the screenshot plan is printed first (key screens: every mode ×
//      language × font scale; the others light/dark, first language, 1.0);
//   2. APK: --apk, else an EAS build of the "qa" profile (--local-build:
//      built on this computer with the production key, BEFORE the emulator
//      starts, so the two never share the RAM; --skip-build or --resume: no
//      build and no install, test what is installed);
//   3. adb install -r, then the installed versionCode must be the expected
//      one: app.json's when the app pins it; otherwise (EAS numbers the
//      builds) the APK's own (aapt2, cross-checked with EAS's
//      appBuildVersion when mk built it), the latest EAS build of the qa
//      profile with --skip-build, or the resumed run's with --resume;
//   4. Maestro smoke flows (<maestroDir>/smoke/*.yaml, in name order);
//   5. screenshots in batches of one device setting, captured with adb
//      screencap. With --emulator, the emulator is cold-restarted before
//      each batch, and mid-batch when host memory runs low; after each
//      boot, a Maestro health check (`maestro hierarchy`), and one driver
//      reinstall if it fails. A batch with 2+ failed screenshots runs
//      once more (after a cold restart on the emulator);
//   6. the device's night mode, font scale and app language are restored,
//      also on failure or Ctrl+C;
//   7. .images/captures/<date>-v<version>/ holds results.json and
//      report.html, rewritten after every step: a killed run still leaves
//      a report, and --resume <dir> continues it. Each failed flow's
//      Maestro debug folder is copied into debug/<name>/.
//
// --dry-run reads the device and prints every change, build, install and
// flow instead of running it.
import fs from 'node:fs';
import path from 'node:path';
import { deviceInfo, dismissForeignAnr, getAppLocales, getFontScale, getNightMode, installedVersionCode, listDevices, requireOneDevice, screencap, setAppLocalesArgs, setFontScaleArgs, shellAct, } from '../android.js';
import { isApk, readBadging } from '../apk.js';
import { localBuild, localBuildPath } from '../build/local.js';
import { easBuild, latestBuildVersion } from '../eas.js';
import { ensureEmulator, isEmulatorSerial, stopEmulator } from '../emulator.js';
import { act, run } from '../exec.js';
import { hostMemory, killLeftoverMaestro, memoryPressure } from '../host.js';
import { detail, fail, info, KitError, warn } from '../log.js';
import { openProject } from '../project.js';
import { confirm } from '../prompt.js';
import { parseMaestroOutput } from './maestro-output.js';
import { buildPlan, settingLabel, shotKey, shotName } from './plan.js';
import { renderReport, scaleLabel } from './report.js';
export const QA_USAGE = 'Usage: mk qa:device [--apk <path>] [--skip-build] [--local-build] [--emulator] [--resume <dir>] [--keep-emulator] [--yes] [--no-open] [--dry-run]';
export function parseQaArgs(args) {
    const o = { skipBuild: false, localBuild: false, emulator: false, keepEmulator: false, yes: false, open: true, dryRun: false };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--apk' || a === '--resume') {
            const value = args[++i];
            if (!value)
                fail(`${a} needs a path. ${QA_USAGE}`);
            if (a === '--apk')
                o.apk = value;
            else
                o.resume = value;
        }
        else if (a === '--skip-build')
            o.skipBuild = true;
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
async function checkpoint() {
    await new Promise((resolve) => setImmediate(resolve));
    if (interrupted)
        throw new KitError('Interrupted (Ctrl+C)');
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
        const built = localBuild(p, config.easProfiles.qa);
        localApk = built.built || p.dryRun ? built.apk : null;
    }
    // --- Device --------------------------------------------------------------
    let serial;
    let ownsEmulator = false;
    /** The emulator booted and nothing ran on it yet: no need to restart it. */
    let freshBoot = false;
    if (o.emulator) {
        const physical = listDevices(p.tool.adb).ready.filter((d) => !isEmulatorSerial(d));
        if (physical.length) {
            fail(`--emulator, but a physical device is connected: ${physical.join(', ')}. ` +
                'Unplug it (or turn off wireless debugging): QA runs on the emulator only.');
        }
        const ready = await ensureEmulator(p);
        ownsEmulator = ready.started;
        freshBoot = ready.started;
        serial = p.dryRun && listDevices(p.tool.adb).ready.length === 0 ? ready.serial : requireOneDevice(p.tool.adb);
    }
    else
        serial = requireOneDevice(p.tool.adb);
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
    // --- Smoke flows still to run; those that wipe the app's data ask first --
    const smokeDone = new Set((previous?.smoke ?? []).map((f) => f.flow));
    const flowName = (file) => path.relative(maestroDir, file).replace(/\\/g, '/');
    const smokeToRun = smoke.filter((f) => !smokeDone.has(flowName(f)));
    const wipes = smokeToRun.filter((f) => /\bclearState\b/.test(fs.readFileSync(f, 'utf8')));
    if (wipes.length) {
        const names = wipes.map((f) => path.basename(f)).join(', ');
        const question = `${names} CLEAR ${config.appName}'s data on ${device.model} (${serial}). Continue?`;
        if (p.dryRun)
            detail(`[dry run] would ask: ${question}`);
        else if (!o.yes && !(await confirm(question)))
            fail('Stopped: nothing installed or changed.');
    }
    // --- Maestro runs a killed mk left behind on this device -----------------
    const leftovers = killLeftoverMaestro(p, serial);
    if (leftovers)
        warn(`Stopped ${leftovers} Maestro process(es) left on ${serial} by an earlier run`);
    // --- Install and versionCode ---------------------------------------------
    if (apk) {
        info(`Installing ${path.basename(apk)} on ${serial} (adb install -r keeps the data)`);
        if (act(p.dryRun, p.tool.adb, ['-s', serial, 'install', '-r', apk]).status !== 0)
            fail('adb install failed');
    }
    const installed = installedVersionCode(p.tool.adb, serial, config.androidPackage);
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
    // --- The run, written after every step -----------------------------------
    const ctx = { p, serial, device, maestroDir, outDir, logDir: path.join(outDir, 'logs') };
    const done = new Map((previous?.shots ?? []).filter((s) => s.file).map((s) => [shotKey(s.screen, s), s]));
    const shots = plan.batches.flatMap((b) => b.screens.map((screen) => done.get(shotKey(screen, b)) ?? { screen, mode: b.mode, lang: b.lang, scale: b.scale }));
    const saved = previous?.saved ?? {
        night: getNightMode(p.tool.adb, serial),
        fontScale: getFontScale(p.tool.adb, serial),
        appLocales: method === 'app-locale' && languages[0] !== 'current' ? getAppLocales(p.tool.adb, serial, config.androidPackage) : null,
    };
    info(`${previous?.saved ? 'Device settings to restore (from the first run)' : 'Saved device settings'}: night mode ${saved.night}, font_scale ${saved.fontScale}` +
        (saved.appLocales !== null ? `, app language ${saved.appLocales || 'system'}` : ''));
    const run_ = {
        appName: config.appName,
        androidPackage: config.androidPackage,
        version: app.version,
        versionCode: expected.versionCode,
        versionCodeFrom: expected.from,
        installedVersionCode: installed,
        apk: apkLabel,
        device,
        startedAt: previous?.startedAt ?? new Date().toISOString(),
        finishedAt: '',
        outDir,
        plan: plan.summary,
        saved,
        smoke: [...(previous?.smoke ?? [])],
        shots,
        notes: [...(previous?.notes ?? []), ...(previous ? [`Resumed ${new Date().toISOString()}`] : []), ...notes],
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
    const anrCheck = () => {
        const n = dismissForeignAnr(p.dryRun, p.tool.adb, ctx.serial, config.androidPackage);
        if (n)
            note(n);
    };
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
    const applySetting = (s) => {
        shellAct(p.dryRun, p.tool.adb, ctx.serial, ['cmd', 'uimode', 'night', s.mode === 'dark' ? 'yes' : 'no']);
        shellAct(p.dryRun, p.tool.adb, ctx.serial, setFontScaleArgs(s.scale.toFixed(2).replace(/0$/, '')));
        setLanguage(s.lang);
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
            // A screen flow only opens a screen: run it again if another app's
            // "isn't responding" dialog was covering it.
            if (!r.ok && !p.dryRun) {
                const n = dismissForeignAnr(false, p.tool.adb, ctx.serial, config.androidPackage);
                if (n?.endsWith('tapped Wait')) {
                    note(`${n} during ${name}: ran it again`);
                    r = maestro(ctx, flow, { APP_ID: config.androidPackage }, `${logName}-retry`, name);
                }
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
    const onSignal = () => {
        interrupted = true;
        warn('Stopping after this step, then restoring the device settings');
    };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const s of signals)
        process.on(s, onSignal);
    let stopError = null;
    try {
        if (o.emulator && ownsEmulator)
            healthCheck();
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
    if (o.open)
        run(p.tool.open, [report]);
    if (stopError)
        throw stopError;
    const smokeFailed = run_.smoke.filter((f) => !f.ok).length;
    const missing = run_.shots.filter((s) => !s.file).length;
    if (smokeFailed || missing)
        fail(`QA: ${smokeFailed} smoke flow(s) failed, ${missing} screenshot(s) missing. See the report.`);
    info('QA done: every smoke flow passed. Now review the screenshots in the report.');
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
