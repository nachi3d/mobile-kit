// mk emulator [--wipe] [--dry-run]
//
// The local Android emulator for device QA:
//   1. creates the AVD (config "emulator", default mk-pixel8-api34) if
//      missing, with avdmanager;
//   2. sets its config.ini: RAM, data partition, hardware keyboard;
//   3. starts it headed (reuses it if it is already running; --wipe
//      restarts it with -wipe-data);
//   4. waits for sys.boot_completed=1, unlocks the screen, keeps it on and
//      turns animations off (stable Maestro runs);
//   5. prints its adb serial.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listDevices, shell } from './android.js';
import type { EmulatorConfig } from './config.js';
import { act, formatCommand, run } from './exec.js';
import { detail, fail, info } from './log.js';
import type { Project } from './project.js';

export const EMULATOR_USAGE = 'Usage: mk emulator [--wipe] [--dry-run]';

/** Local emulators are "emulator-<port>" on adb; anything else is hardware (USB or Wi-Fi). */
export const isEmulatorSerial = (serial: string) => /^emulator-\d+$/.test(serial);

export function avdHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME;
  const user = env.ANDROID_USER_HOME ?? path.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), '.android');
  return path.join(user, 'avd');
}

const pollMs = () => Number(process.env.MK_POLL_MS) || 2000;
const bootTimeoutMs = () => Number(process.env.MK_BOOT_TIMEOUT_MS) || 300_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** config.ini lines for the keys mk manages; everything else is kept. */
export function tuneConfigIni(text: string, e: EmulatorConfig): string {
  const wanted: Record<string, string> = {
    'hw.ramSize': `${e.ramMb}M`,
    'disk.dataPartition.size': e.dataPartition,
    'hw.keyboard': 'yes',
  };
  const seen = new Set<string>();
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
  for (const [k, v] of Object.entries(wanted)) if (!seen.has(k)) lines.push(`${k}=${v}`);
  return `${lines.join('\n')}\n`;
}

/** Serial of the running emulator whose AVD is `avd`, or null. */
function runningSerial(p: Project, avd: string): string | null {
  for (const serial of listDevices(p.tool.adb).ready.filter(isEmulatorSerial)) {
    const name = run(p.tool.adb, ['-s', serial, 'emu', 'avd', 'name']).stdout.split('\n')[0]?.trim();
    if (name === avd) return serial;
  }
  return null;
}

function ensureAvd(p: Project): void {
  const e = p.config.emulator;
  const dir = avdHome();
  const ini = path.join(dir, `${e.avd}.ini`);
  if (!fs.existsSync(ini)) {
    info(`Creating AVD ${e.avd} (${e.device}, ${e.image})`);
    const r = act(p.dryRun, p.tool.avdmanager, ['create', 'avd', '-n', e.avd, '-k', e.image, '-d', e.device], { input: 'no\n' });
    if (r.status !== 0) {
      fail(
        `avdmanager could not create ${e.avd}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}\n` +
          `    Is the system image installed? Android SDK → cmdline-tools/latest/bin:\n` +
          `    android sdk install ${e.image.replace(/;/g, '/')}   (or: sdkmanager "${e.image}")`,
      );
    }
    if (p.dryRun) return;
  } else info(`AVD ${e.avd} exists`);
  const config = path.join(dir, `${e.avd}.avd`, 'config.ini');
  if (!fs.existsSync(config)) fail(`No ${config}: the AVD is broken. Delete ${e.avd} (avdmanager delete avd -n ${e.avd}) and run again.`);
  const before = fs.readFileSync(config, 'utf8');
  const after = tuneConfigIni(before, e);
  if (after.replace(/\r/g, '') !== before.replace(/\r/g, '')) {
    if (p.dryRun) detail(`[dry run, not executed] set ${config}: RAM ${e.ramMb}M, data ${e.dataPartition}, hw.keyboard=yes`);
    else {
      fs.writeFileSync(config, after);
      detail(`config.ini: RAM ${e.ramMb}M, data partition ${e.dataPartition}, hardware keyboard`);
    }
  }
}

/** Starts (or reuses) the emulator and returns its serial once it is ready. */
export async function ensureEmulator(p: Project, options: { wipe: boolean }): Promise<string> {
  const e = p.config.emulator;
  ensureAvd(p);

  let serial = runningSerial(p, e.avd);
  if (serial && options.wipe) {
    info(`Stopping ${e.avd} (${serial}) to wipe it`);
    act(p.dryRun, p.tool.adb, ['-s', serial, 'emu', 'kill']);
    if (!p.dryRun) {
      const deadline = Date.now() + 60_000;
      while (runningSerial(p, e.avd) && Date.now() < deadline) await sleep(pollMs());
    }
    serial = null;
  }
  if (serial) info(`${e.avd} is already running: ${serial}`);
  else {
    const args = ['-avd', e.avd, '-no-boot-anim', '-no-audio', ...(options.wipe ? ['-wipe-data'] : [])];
    info(`Starting ${e.avd}${options.wipe ? ' with wiped data' : ''} (a window opens)`);
    const [cmd, ...pre] = p.tool.emulator;
    if (p.dryRun || !cmd) detail(`[dry run, not executed] ${formatCommand([...p.tool.emulator, ...args])}`);
    else {
      const child = spawn(cmd, [...pre, ...args], { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', () => undefined);
      child.unref();
    }
    if (p.dryRun) return 'emulator-5554';
    const deadline = Date.now() + bootTimeoutMs();
    while (!(serial = runningSerial(p, e.avd))) {
      if (Date.now() > deadline) fail(`${e.avd} did not appear on adb within ${bootTimeoutMs() / 1000} s. Is hardware acceleration on? Run: emulator -accel-check`);
      await sleep(pollMs());
    }
  }

  if (!p.dryRun) {
    info(`Waiting for ${serial} to boot`);
    const deadline = Date.now() + bootTimeoutMs();
    while (shell(p.tool.adb, serial, ['getprop', 'sys.boot_completed']) !== '1') {
      if (Date.now() > deadline) fail(`${serial} did not finish booting within ${bootTimeoutMs() / 1000} s`);
      await sleep(pollMs());
    }
  }

  info('Unlocking the screen and turning animations off');
  const settings: string[][] = [
    ['input', 'keyevent', 'KEYCODE_WAKEUP'],
    ['wm', 'dismiss-keyguard'],
    ['input', 'keyevent', '82'],
    ['svc', 'power', 'stayon', 'true'],
    ['settings', 'put', 'global', 'window_animation_scale', '0'],
    ['settings', 'put', 'global', 'transition_animation_scale', '0'],
    ['settings', 'put', 'global', 'animator_duration_scale', '0'],
  ];
  for (const args of settings) act(p.dryRun, p.tool.adb, ['-s', serial, 'shell', ...args]);
  info(`Emulator ready: ${serial}`);
  return serial;
}

export function parseEmulatorArgs(args: string[]): { wipe: boolean; dryRun: boolean } {
  const o = { wipe: false, dryRun: false };
  for (const a of args) {
    if (a === '--wipe') o.wipe = true;
    else if (a === '--dry-run') o.dryRun = true;
    else fail(`Unknown option: ${a}. ${EMULATOR_USAGE}`);
  }
  return o;
}
