import { act, run, type RunResult } from './exec.js';
import { fail } from './log.js';

export const DEVICE_HELP = `Connect exactly one Android device or emulator:
    - Phone: Settings → About phone → tap "Build number" 7 times; then
      Settings → System → Developer options → USB debugging ON. Plug it in
      and accept "Allow USB debugging?" on the phone.
    - Emulator: Android Studio → Device Manager → start one.
    - Check with: adb devices   (one line ending in "device")
    - Several listed? Unplug phones / stop emulators until one is left.`;

export interface DeviceList {
  ready: string[];
  /** serial → state, for "unauthorized", "offline", … */
  other: [string, string][];
}

export function listDevices(adb: string[]): DeviceList {
  const r = run(adb, ['devices']);
  const list: DeviceList = { ready: [], other: [] };
  if (r.status !== 0) return list;
  for (const line of r.stdout.split('\n').slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (!serial || !state) continue;
    if (state === 'device') list.ready.push(serial);
    else list.other.push([serial, state]);
  }
  return list;
}

/** The one ready device, or a stop with help. */
export function requireOneDevice(adb: string[]): string {
  const { ready, other } = listDevices(adb);
  if (ready.length === 1 && ready[0]) return ready[0];
  const notReady = other.length ? `\n    Not ready: ${other.map(([s, st]) => `${s} (${st})`).join(', ')}` : '';
  fail(`${ready.length} device(s) ready on adb, need exactly 1.${notReady}\n${DEVICE_HELP}`);
}

/** adb -s <serial> shell <args>: stdout, trimmed. */
export function shell(adb: string[], serial: string, args: string[]): string {
  return run(adb, ['-s', serial, 'shell', ...args]).stdout.trim();
}

export function shellAct(dryRun: boolean, adb: string[], serial: string, args: string[]): RunResult {
  return act(dryRun, adb, ['-s', serial, 'shell', ...args]);
}

export function installedVersionCode(adb: string[], serial: string, pkg: string): number | null {
  const out = shell(adb, serial, ['dumpsys', 'package', pkg]);
  const m = /versionCode=(\d+)/.exec(out);
  return m?.[1] ? Number(m[1]) : null;
}

export interface DeviceInfo {
  serial: string;
  model: string;
  manufacturer: string;
  androidVersion: string;
  sdk: number;
}

export function deviceInfo(adb: string[], serial: string): DeviceInfo {
  const prop = (name: string) => shell(adb, serial, ['getprop', name]);
  return {
    serial,
    model: prop('ro.product.model') || 'unknown',
    manufacturer: prop('ro.product.manufacturer') || '',
    androidVersion: prop('ro.build.version.release') || '?',
    sdk: Number(prop('ro.build.version.sdk')) || 0,
  };
}

// --- Settings the screenshot matrix changes, saved and restored -----------

/** `cmd uimode night` prints "Night mode: no" (or yes, auto, custom…). */
export function getNightMode(adb: string[], serial: string): string {
  const out = shell(adb, serial, ['cmd', 'uimode', 'night']);
  return /Night mode:\s*(\S+)/i.exec(out)?.[1]?.toLowerCase() ?? 'unknown';
}

/** "null" when never set (the system default, 1.0). */
export function getFontScale(adb: string[], serial: string): string {
  return shell(adb, serial, ['settings', 'get', 'system', 'font_scale']) || 'null';
}

export function setFontScaleArgs(value: string): string[] {
  return value === 'null' ? ['settings', 'delete', 'system', 'font_scale'] : ['settings', 'put', 'system', 'font_scale', value];
}

/** Android 13+: "Locales for <pkg> for user 0 are [fr-FR]" → "fr-FR" ("" = follows the system). */
export function getAppLocales(adb: string[], serial: string, pkg: string): string {
  const out = shell(adb, serial, ['cmd', 'locale', 'get-app-locales', pkg, '--user', 'current']);
  return /\[([^\]]*)\]/.exec(out)?.[1]?.trim() ?? '';
}

/** An empty list puts the app back on the system language. */
export function setAppLocalesArgs(pkg: string, locales: string): string[] {
  return ['cmd', 'locale', 'set-app-locales', pkg, '--user', 'current', '--locales', locales === '' ? '""' : locales];
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The current screen as PNG bytes, or null. */
export function screencap(adb: string[], serial: string): Buffer | null {
  const r = run(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { binary: true });
  if (r.status !== 0) return null;
  const bytes = r.stdoutBytes;
  return bytes.subarray(0, 8).equals(PNG_SIGNATURE) ? bytes : null;
}
