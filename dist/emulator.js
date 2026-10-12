// mk emulator [--wipe] [--dry-run]
//
// The local Android emulator for device QA:
//   1. creates the AVD (config "emulator", default mk-pixel8-api34) if
//      missing, with avdmanager;
//   2. sets its config.ini: RAM, data partition, hardware keyboard, GPU;
//   3. starts it with -gpu <emulator.gpu> (default host; one retry with
//      swiftshader_indirect if that does not boot), headless if configured
//      (reuses it if it is already running; --wipe restarts it with
//      -wipe-data);
//   4. waits for sys.boot_completed=1, unlocks the screen, keeps it on and
//      turns animations off (stable Maestro runs);
//   5. prints its adb serial.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dismissForeignAnr, listDevices, shell } from './android.js';
import { GPU_FALLBACK } from './config.js';
import { act, formatCommand, run } from './exec.js';
import { killEmulatorProcesses } from './host.js';
import { detail, fail, info, warn } from './log.js';
export const EMULATOR_USAGE = 'Usage: mk emulator [--wipe] [--dry-run]';
/** Local emulators are "emulator-<port>" on adb; anything else is hardware (USB or Wi-Fi). */
export const isEmulatorSerial = (serial) => /^emulator-\d+$/.test(serial);
export function avdHome(env = process.env) {
    if (env.ANDROID_AVD_HOME)
        return env.ANDROID_AVD_HOME;
    const user = env.ANDROID_USER_HOME ?? path.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), '.android');
    return path.join(user, 'avd');
}
const pollMs = () => Number(process.env.MK_POLL_MS) || 2000;
const bootTimeoutMs = () => Number(process.env.MK_BOOT_TIMEOUT_MS) || 300_000;
const stopTimeoutMs = () => Number(process.env.MK_STOP_TIMEOUT_MS) || 60_000;
/** After a boot, the launcher and Play services are still busy for a while. */
const settleMs = () => (process.env.MK_SETTLE_MS !== undefined ? Number(process.env.MK_SETTLE_MS) : 20_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** config.ini lines for the keys mk manages; everything else is kept. */
export function tuneConfigIni(text, e) {
    const wanted = {
        'hw.ramSize': `${e.ramMb}M`,
        'disk.dataPartition.size': e.dataPartition,
        'hw.keyboard': 'yes',
        'hw.gpu.enabled': 'yes',
        'hw.gpu.mode': e.gpu,
    };
    const seen = new Set();
    const lines = text
        .split(/\r?\n/)
        .filter((l) => l !== '')
        .map((line) => {
        const key = line.slice(0, line.indexOf('=')).trim();
        if (key in wanted) {
            seen.add(key);
            return `${key}=${wanted[key]}`;
        }
        return line;
    });
    for (const [k, v] of Object.entries(wanted))
        if (!seen.has(k))
            lines.push(`${k}=${v}`);
    return `${lines.join('\n')}\n`;
}
/** Serial of the running emulator whose AVD is `avd`, or null. */
function runningSerial(p, avd) {
    for (const serial of listDevices(p.tool.adb).ready.filter(isEmulatorSerial)) {
        const name = run(p.tool.adb, ['-s', serial, 'emu', 'avd', 'name']).stdout.split('\n')[0]?.trim();
        if (name === avd)
            return serial;
    }
    return null;
}
function ensureAvd(p) {
    const e = p.config.emulator;
    const dir = avdHome();
    const ini = path.join(dir, `${e.avd}.ini`);
    if (!fs.existsSync(ini)) {
        info(`Creating AVD ${e.avd} (${e.device}, ${e.image})`);
        const r = act(p.dryRun, p.tool.avdmanager, ['create', 'avd', '-n', e.avd, '-k', e.image, '-d', e.device], { input: 'no\n' });
        if (r.status !== 0) {
            fail(`avdmanager could not create ${e.avd}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}\n` +
                `    Is the system image installed? Android SDK → cmdline-tools/latest/bin:\n` +
                `    android sdk install ${e.image.replace(/;/g, '/')}   (or: sdkmanager "${e.image}")`);
        }
        if (p.dryRun)
            return;
    }
    else
        info(`AVD ${e.avd} exists`);
    const config = path.join(dir, `${e.avd}.avd`, 'config.ini');
    if (!fs.existsSync(config))
        fail(`No ${config}: the AVD is broken. Delete ${e.avd} (avdmanager delete avd -n ${e.avd}) and run again.`);
    const before = fs.readFileSync(config, 'utf8');
    const after = tuneConfigIni(before, e);
    if (after.replace(/\r/g, '') !== before.replace(/\r/g, '')) {
        if (p.dryRun)
            detail(`[dry run, not executed] set ${config}: RAM ${e.ramMb}M, data ${e.dataPartition}, hw.keyboard=yes, GPU ${e.gpu}`);
        else {
            fs.writeFileSync(config, after);
            detail(`config.ini: RAM ${e.ramMb}M, data partition ${e.dataPartition}, hardware keyboard, GPU ${e.gpu}`);
        }
    }
}
/** Emulator command-line arguments. */
export function emulatorArgs(e, gpu, o) {
    return [
        '-avd',
        e.avd,
        '-no-boot-anim',
        '-no-audio',
        '-gpu',
        gpu,
        ...(e.headless ? ['-no-window'] : []),
        ...(o.cold ? ['-no-snapshot'] : []),
        ...(o.wipe ? ['-wipe-data'] : []),
    ];
}
/** Stops the AVD's emulator: `adb emu kill`, then its processes if it does not go away. */
export async function stopEmulator(p, serial) {
    const avd = p.config.emulator.avd;
    act(p.dryRun, p.tool.adb, ['-s', serial, 'emu', 'kill']);
    if (p.dryRun)
        return;
    const gone = async (ms) => {
        const deadline = Date.now() + ms;
        while (runningSerial(p, avd)) {
            if (Date.now() > deadline)
                return false;
            await sleep(pollMs());
        }
        return true;
    };
    if (await gone(stopTimeoutMs()))
        return;
    warn(`${avd} did not stop with "adb emu kill": killing its processes`);
    killEmulatorProcesses(p, avd);
    await gone(stopTimeoutMs());
}
/** Launches the emulator and waits until adb sees it booted; null when it failed. */
async function boot(p, gpu, o) {
    const e = p.config.emulator;
    const args = emulatorArgs(e, gpu, o);
    const how = [o.cold ? 'cold' : '', o.wipe ? 'with wiped data' : '', `GPU ${gpu}`, e.headless ? 'no window' : 'a window opens']
        .filter(Boolean)
        .join(', ');
    info(`Starting ${e.avd} (${how})`);
    const [cmd, ...pre] = p.tool.emulator;
    if (p.dryRun || !cmd) {
        detail(`[dry run, not executed] ${formatCommand([...p.tool.emulator, ...args])}`);
        return 'emulator-5554';
    }
    let exitCode = null;
    const child = spawn(cmd, [...pre, ...args], { detached: true, stdio: 'ignore', windowsHide: e.headless });
    child.on('error', () => (exitCode = 127));
    child.on('exit', (code) => (exitCode = code ?? 1));
    child.unref();
    const deadline = Date.now() + bootTimeoutMs();
    let serial;
    while (!(serial = runningSerial(p, e.avd))) {
        if (exitCode !== null && exitCode !== 0) {
            warn(`The emulator exited with code ${exitCode} before appearing on adb`);
            return null;
        }
        if (Date.now() > deadline) {
            warn(`${e.avd} did not appear on adb within ${bootTimeoutMs() / 1000} s`);
            return null;
        }
        await sleep(pollMs());
    }
    info(`Waiting for ${serial} to boot`);
    while (shell(p.tool.adb, serial, ['getprop', 'sys.boot_completed']) !== '1') {
        if (Date.now() > deadline) {
            warn(`${serial} did not finish booting within ${bootTimeoutMs() / 1000} s`);
            await stopEmulator(p, serial);
            return null;
        }
        await sleep(pollMs());
    }
    return serial;
}
/** Starts (or reuses) the emulator and returns its serial once it is ready. */
export async function ensureEmulator(p, o = {}) {
    const e = p.config.emulator;
    ensureAvd(p);
    let serial = runningSerial(p, e.avd);
    if (serial && (o.wipe || o.cold)) {
        info(`Stopping ${e.avd} (${serial}) to ${o.wipe ? 'wipe it' : 'restart it cold'}`);
        await stopEmulator(p, serial);
        serial = null;
    }
    const started = !serial;
    if (serial)
        info(`${e.avd} is already running: ${serial}`);
    else {
        serial = await boot(p, e.gpu, o);
        if (!serial && e.gpu !== GPU_FALLBACK) {
            warn(`GPU mode "${e.gpu}" did not boot: retrying once with ${GPU_FALLBACK} (software rendering, uses more host memory)`);
            serial = await boot(p, GPU_FALLBACK, o);
        }
        if (!serial)
            fail(`${e.avd} did not start. Is hardware acceleration on? Run: emulator -accel-check`);
    }
    info('Unlocking the screen and turning animations off');
    const settings = [
        ['input', 'keyevent', 'KEYCODE_WAKEUP'],
        ['wm', 'dismiss-keyguard'],
        ['input', 'keyevent', '82'],
        ['svc', 'power', 'stayon', 'true'],
        ['settings', 'put', 'global', 'window_animation_scale', '0'],
        ['settings', 'put', 'global', 'transition_animation_scale', '0'],
        ['settings', 'put', 'global', 'animator_duration_scale', '0'],
    ];
    for (const args of settings)
        act(p.dryRun, p.tool.adb, ['-s', serial, 'shell', ...args]);
    if (started && !p.dryRun) {
        detail(`Letting the system settle for ${settleMs() / 1000} s`);
        await sleep(settleMs());
        const anr = dismissForeignAnr(false, p.tool.adb, serial, p.config.androidPackage);
        if (anr)
            warn(anr);
    }
    info(`Emulator ready: ${serial}`);
    return { serial, started };
}
export function parseEmulatorArgs(args) {
    const o = { wipe: false, dryRun: false };
    for (const a of args) {
        if (a === '--wipe')
            o.wipe = true;
        else if (a === '--dry-run')
            o.dryRun = true;
        else
            fail(`Unknown option: ${a}. ${EMULATOR_USAGE}`);
    }
    return o;
}
