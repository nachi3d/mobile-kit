// mk qa:device [--apk <path>] [--skip-build] [--yes] [--no-open] [--dry-run]
//
// Device QA on the one connected phone or emulator:
//   1. APK: --apk, else an EAS build of the "qa" profile (--skip-build: no
//      build and no install, test what is installed);
//   2. adb install -r, then the installed versionCode must be app.json's;
//   3. Maestro smoke flows (<maestroDir>/smoke/*.yaml, in name order);
//   4. screenshot matrix: each screen flow × light/dark × languages × font
//      scales, captured with adb screencap;
//   5. the device's night mode, font scale and app language are restored,
//      also on failure or Ctrl+C;
//   6. .images/captures/<date>-v<version>/report.html, opened.
//
// --dry-run reads the device and prints every change, build, install and
// flow instead of running it.
import fs from 'node:fs';
import path from 'node:path';
import { deviceInfo, getAppLocales, getFontScale, getNightMode, installedVersionCode, requireOneDevice, screencap, setAppLocalesArgs, setFontScaleArgs, shellAct, } from '../android.js';
import { isApk } from '../apk.js';
import { easBuild } from '../eas.js';
import { act, run } from '../exec.js';
import { detail, fail, info, KitError, warn } from '../log.js';
import { openProject } from '../project.js';
import { confirm } from '../prompt.js';
import { renderReport, scaleLabel } from './report.js';
export const QA_USAGE = 'Usage: mk qa:device [--apk <path>] [--skip-build] [--yes] [--no-open] [--dry-run]';
export function parseQaArgs(args) {
    const o = { skipBuild: false, yes: false, open: true, dryRun: false };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--apk') {
            const value = args[++i];
            if (!value)
                fail(`--apk needs a path. ${QA_USAGE}`);
            o.apk = value;
        }
        else if (a === '--skip-build')
            o.skipBuild = true;
        else if (a === '--yes')
            o.yes = true;
        else if (a === '--no-open')
            o.open = false;
        else if (a === '--dry-run')
            o.dryRun = true;
        else
            fail(`Unknown option: ${a}. ${QA_USAGE}`);
    }
    return o;
}
const yamlFiles = (dir) => fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => /\.ya?ml$/.test(f) && !f.startsWith('_'))
        .sort()
    : [];
/** Ctrl+C sets this; the run stops at the next step and restores the device. */
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
function maestro(ctx, flowPath, env, logName) {
    const args = ['--device', ctx.serial, 'test', flowPath, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])];
    const flow = path.relative(ctx.maestroDir, flowPath).replace(/\\/g, '/');
    if (ctx.p.dryRun) {
        act(true, ctx.p.tool.maestro, args);
        return { flow, ok: true, seconds: 0 };
    }
    const started = Date.now();
    const r = run(ctx.p.tool.maestro, args, { cwd: ctx.p.root });
    const output = `${r.stdout}\n${r.stderr}`.trim();
    fs.mkdirSync(ctx.logDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.logDir, `${logName}.log`), output);
    const ok = r.status === 0;
    return {
        flow,
        ok,
        seconds: (Date.now() - started) / 1000,
        ...(ok ? {} : { error: output.split('\n').slice(-25).join('\n') }),
    };
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
    const screens = config.screens.map((name) => {
        const file = path.join(maestroDir, 'screens', `${name}.yaml`);
        if (!fs.existsSync(file))
            fail(`Screen flow missing: ${config.maestroDir}/screens/${name}.yaml (mobile-kit.config.json "screens")`);
        return { name, file };
    });
    const langFlow = config.languages.method === 'flow' ? path.join(maestroDir, config.languages.flow ?? '') : null;
    if (langFlow && !fs.existsSync(langFlow))
        fail(`Language flow missing: ${config.maestroDir}/${config.languages.flow}`);
    // --- Device --------------------------------------------------------------
    const serial = requireOneDevice(p.tool.adb);
    const device = deviceInfo(p.tool.adb, serial);
    info(`Device: ${device.manufacturer} ${device.model}, Android ${device.androidVersion} (API ${device.sdk}), ${serial}`);
    // --- APK -----------------------------------------------------------------
    let apk = null;
    let apkLabel;
    if (o.apk) {
        apk = path.resolve(o.apk);
        if (!isApk(apk))
            fail(`Not an APK: ${o.apk}`);
        apkLabel = path.basename(apk);
    }
    else if (o.skipBuild) {
        apkLabel = 'already installed (--skip-build)';
    }
    else {
        apk = path.join(p.root, 'dist', `${config.apkName}-${app.version}-qa.apk`);
        apkLabel = `EAS ${config.easProfiles.qa} build → ${path.basename(apk)}`;
        if (!easBuild(p, config.easProfiles.qa, apk))
            apk = p.dryRun ? apk : null;
    }
    // --- Smoke flows that wipe the app's data ask first ----------------------
    const wipes = smoke.filter((f) => /\bclearState\b/.test(fs.readFileSync(f, 'utf8')));
    if (wipes.length) {
        const names = wipes.map((f) => path.basename(f)).join(', ');
        const question = `${names} CLEAR ${config.appName}'s data on ${device.model} (${serial}). Continue?`;
        if (p.dryRun)
            detail(`[dry run] would ask: ${question}`);
        else if (!o.yes && !(await confirm(question)))
            fail('Stopped: nothing installed or changed.');
    }
    // --- Install and versionCode ---------------------------------------------
    if (apk) {
        info(`Installing ${path.basename(apk)} on ${serial} (adb install -r keeps the data)`);
        if (act(p.dryRun, p.tool.adb, ['-s', serial, 'install', '-r', apk]).status !== 0)
            fail('adb install failed');
    }
    const installed = installedVersionCode(p.tool.adb, serial, config.androidPackage);
    if (installed !== app.versionCode) {
        const message = `Installed versionCode is ${installed ?? 'none'}, app.json says ${app.versionCode}.`;
        if (p.dryRun)
            warn(`${message} (dry run: nothing was installed; a real run stops here)`);
        else
            fail(`${message} Wrong build on the device: stopped before testing.`);
    }
    else
        info(`Installed versionCode ${installed} = app.json`);
    // --- Runs ----------------------------------------------------------------
    const outDir = outputDir(p.root, app.version);
    const ctx = { p, serial, device, maestroDir, logDir: path.join(outDir, 'logs') };
    const run_ = {
        appName: config.appName,
        androidPackage: config.androidPackage,
        version: app.version,
        versionCode: app.versionCode,
        installedVersionCode: installed,
        apk: apkLabel,
        device,
        startedAt: new Date().toISOString(),
        finishedAt: '',
        smoke: [],
        shots: [],
        notes: [],
    };
    // Language switching.
    let languages = config.languages.codes;
    const method = config.languages.method;
    if (method === 'app-locale' && device.sdk < 33) {
        const note = `Per-app language needs Android 13+ (this device: API ${device.sdk}): screenshots in the current language only.`;
        warn(note);
        run_.notes.push(note);
        languages = ['current'];
    }
    const saved = {
        night: getNightMode(p.tool.adb, serial),
        fontScale: getFontScale(p.tool.adb, serial),
        appLocales: method === 'app-locale' && languages[0] !== 'current' ? getAppLocales(p.tool.adb, serial, config.androidPackage) : null,
    };
    info(`Saved device settings: night mode ${saved.night}, font_scale ${saved.fontScale}` +
        (saved.appLocales !== null ? `, app language ${saved.appLocales || 'system'}` : ''));
    const setLanguage = (lang) => {
        if (lang === 'current')
            return;
        if (method === 'app-locale')
            shellAct(p.dryRun, p.tool.adb, serial, setAppLocalesArgs(config.androidPackage, lang));
        else if (method === 'deep-link') {
            const url = (config.languages.deepLink ?? '').replace('{lang}', lang);
            shellAct(p.dryRun, p.tool.adb, serial, ['am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', url, config.androidPackage]);
        }
        else if (langFlow) {
            const r = maestro(ctx, langFlow, { APP_ID: config.androidPackage, LANG: lang }, `language-${lang}`);
            if (!r.ok)
                throw new KitError(`Language flow failed for ${lang}: ${r.error ?? ''}`);
        }
    };
    const onSigint = () => {
        interrupted = true;
        warn('Ctrl+C: stopping after this step, then restoring the device settings');
    };
    process.on('SIGINT', onSigint);
    let stopError = null;
    try {
        // Smoke.
        if (smoke.length)
            info(`Maestro smoke flows (${smoke.length})`);
        for (const file of smoke) {
            await checkpoint();
            detail(`${path.basename(file)} …`);
            const r = maestro(ctx, file, { APP_ID: config.androidPackage }, `smoke-${path.basename(file, path.extname(file))}`);
            run_.smoke.push(r);
            if (!p.dryRun)
                detail(`${r.ok ? 'PASS' : 'FAIL'} ${r.flow} (${r.seconds.toFixed(1)} s)`);
        }
        // Matrix.
        const total = screens.length * config.modes.length * languages.length * config.fontScales.length;
        info(`Screenshots: ${screens.length} screens × ${config.modes.length} modes × ${languages.length} languages × ${config.fontScales.length} font scales = ${total}`);
        if (!p.dryRun)
            fs.mkdirSync(outDir, { recursive: true });
        for (const mode of config.modes) {
            await checkpoint();
            shellAct(p.dryRun, p.tool.adb, serial, ['cmd', 'uimode', 'night', mode === 'dark' ? 'yes' : 'no']);
            for (const scale of config.fontScales) {
                await checkpoint();
                shellAct(p.dryRun, p.tool.adb, serial, setFontScaleArgs(scale.toFixed(2).replace(/0$/, '')));
                for (const lang of languages) {
                    await checkpoint();
                    setLanguage(lang);
                    for (const screen of screens) {
                        await checkpoint();
                        const name = `${screen.name}_${mode}_${lang}_${scale.toFixed(1)}x`;
                        const shot = { screen: screen.name, mode, lang, scale };
                        const r = maestro(ctx, screen.file, { APP_ID: config.androidPackage }, `screen-${name}`);
                        if (p.dryRun) {
                            detail(`[dry run, not executed] adb -s ${serial} exec-out screencap -p > ${name}.png`);
                        }
                        else if (!r.ok) {
                            shot.error = `Flow failed: ${r.error?.split('\n').slice(-3).join(' ') ?? ''}`;
                        }
                        else {
                            const png = screencap(p.tool.adb, serial);
                            if (png) {
                                fs.writeFileSync(path.join(outDir, `${name}.png`), png);
                                shot.file = `${name}.png`;
                            }
                            else
                                shot.error = 'adb screencap returned no PNG';
                        }
                        run_.shots.push(shot);
                        if (!p.dryRun)
                            detail(`${shot.file ? 'OK  ' : 'MISS'} ${screen.name} · ${mode} · ${lang} · ${scaleLabel(scale)}`);
                    }
                }
            }
        }
    }
    catch (e) {
        stopError = e;
    }
    finally {
        process.off('SIGINT', onSigint);
        restore(ctx, saved, run_);
    }
    if (p.dryRun) {
        if (stopError)
            throw stopError;
        info('Dry run: no report written');
        return;
    }
    run_.finishedAt = new Date().toISOString();
    if (stopError)
        run_.notes.push(`Stopped early: ${stopError.message}`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify(run_, null, 2)}\n`);
    const report = path.join(outDir, 'report.html');
    fs.writeFileSync(report, renderReport(run_));
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
            const r = fn();
            if (r && r.status !== 0)
                throw new Error(r.stderr.trim() || `exit ${r.status}`);
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
