import fs from 'node:fs';
import path from 'node:path';

import { fail, warn } from './log.js';

export const CONFIG_FILE = 'mobile-kit.config.json';

export type LanguageMethod = 'app-locale' | 'flow' | 'deep-link';

export interface LanguageConfig {
  /** App languages to screenshot, e.g. ["en", "fr"]. */
  codes: string[];
  /**
   * How the app language is switched:
   * - "app-locale": Android 13+ per-app language (adb `cmd locale
   *   set-app-locales`); restored afterwards. The default, for apps that
   *   follow the system language.
   * - "flow": a Maestro flow (`flow`, relative to maestroDir) run with
   *   `-e LANG=<code>`, for apps with a language setting.
   * - "deep-link": `deepLink` with `{lang}` replaced, opened with adb.
   */
  method: LanguageMethod;
  flow?: string;
  deepLink?: string;
  /** "flow" / "deep-link": value set at the end, e.g. "system". */
  restore?: string;
}

export const GPU_MODES = ['host', 'swiftshader_indirect', 'angle_indirect', 'guest', 'auto'] as const;
export type GpuMode = (typeof GPU_MODES)[number];

/** Software rendering, used only when the configured GPU mode fails to boot. */
export const GPU_FALLBACK: GpuMode = 'swiftshader_indirect';

export interface EmulatorConfig {
  /** AVD name. Default "mk-pixel8-api34". */
  avd: string;
  /** avdmanager device id. Default "pixel_8". */
  device: string;
  /** sdkmanager package of the system image. */
  image: string;
  /** config.ini values set on every start: RAM (MB), data partition, keyboard, GPU. */
  ramMb: number;
  dataPartition: string;
  /**
   * Default "host": the PC's graphics card. Software rendering
   * (swiftshader) grew the emulator past 14 GB of host memory during a
   * screenshot run. If the emulator fails to boot with this mode, mk retries
   * once with swiftshader_indirect.
   */
  gpu: GpuMode;
  /** Start without a window (-no-window). Default false. */
  headless: boolean;
  /** qa:device restarts the emulator when free host RAM falls below this (MB). Default 2048. */
  minFreeMb: number;
  /** …or when the emulator process uses more than this (MB). Default 6144. */
  maxEmulatorMb: number;
}

export const EMULATOR_DEFAULTS: EmulatorConfig = {
  avd: 'mk-pixel8-api34',
  device: 'pixel_8',
  image: 'system-images;android-34;google_apis_playstore;x86_64',
  ramMb: 4096,
  dataPartition: '8G',
  gpu: 'host',
  headless: false,
  minFreeMb: 2048,
  maxEmulatorMb: 6144,
};

export interface ScreenConfig {
  name: string;
  /**
   * Key screens get the full matrix (every mode × language × font scale);
   * the others only light and dark, in the first language, at scale 1.0.
   */
  key: boolean;
}

export interface KitConfig {
  appName: string;
  androidPackage: string;
  /** APK file name prefix: <apkName>-<version>.apk */
  apkName: string;
  r2Bucket: string;
  r2Prefix: string;
  /** Public host of the bucket, no scheme: downloads.example.com */
  downloadsHost: string;
  /** EAS production keystore certificate, AA:BB:… (20 bytes). */
  signingSha1: string;
  /** Maestro folder, relative to the app root: smoke/ and screens/ inside. */
  maestroDir: string;
  /**
   * Screen flows to screenshot: <maestroDir>/screens/<name>.yaml. In the
   * config file each entry is "<name>" or { "name": "<name>", "key": true }.
   */
  screens: ScreenConfig[];
  /** EAS build profiles. Defaults: qa "preview", release "production". */
  easProfiles: { qa: string; release: string };
  languages: LanguageConfig;
  /** Default ["light", "dark"]. */
  modes: ('light' | 'dark')[];
  /** Android font scales. Default [1.0, 1.3]. */
  fontScales: number[];
  /** `mk emulator` / `qa:device --emulator`. Every key optional. */
  emulator: EmulatorConfig;
}

const REQUIRED = [
  'appName',
  'androidPackage',
  'apkName',
  'r2Bucket',
  'r2Prefix',
  'downloadsHost',
  'signingSha1',
  'maestroDir',
] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

/** "AA:BB:…" or 40 hex digits → 40 lowercase hex digits, or null. */
export function normalizeSha1(value: string): string | null {
  const hex = value.replace(/:/g, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex)) return null;
  if (value.includes(':') && !/^([0-9a-fA-F]{2}:){19}[0-9a-fA-F]{2}$/.test(value)) return null;
  return hex;
}

/** Every problem of a parsed config, or [] when it is valid. */
export function validateConfig(raw: unknown): string[] {
  if (!isRecord(raw)) return ['must be a JSON object'];
  const errors: string[] = [];
  for (const key of REQUIRED) {
    if (typeof raw[key] !== 'string' || raw[key].trim() === '') errors.push(`"${key}" must be a non-empty string`);
  }
  const s = (k: string) => (typeof raw[k] === 'string' ? raw[k] : '');
  if (s('androidPackage') && !/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(s('androidPackage'))) {
    errors.push('"androidPackage" is not an Android application id (com.example.app)');
  }
  if (s('apkName') && !/^[\w.-]+$/.test(s('apkName'))) errors.push('"apkName" may contain only letters, digits, "-", "_", "."');
  if (s('r2Prefix') && !/^[\w.-]+(\/[\w.-]+)*$/.test(s('r2Prefix'))) {
    errors.push('"r2Prefix" is a folder like "myapp" (no leading or trailing "/")');
  }
  if (s('downloadsHost') && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s('downloadsHost'))) {
    errors.push('"downloadsHost" is a host name like downloads.example.com (no https://, no path)');
  }
  if (s('signingSha1') && !normalizeSha1(s('signingSha1'))) {
    errors.push('"signingSha1" must be the 20-byte certificate SHA-1, AA:BB:… (eas credentials → Keystore)');
  }
  const screenName = (n: unknown) => typeof n === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(n);
  const screenOk = (s: unknown) =>
    screenName(s) ||
    (isRecord(s) &&
      screenName(s.name) &&
      (s.key === undefined || typeof s.key === 'boolean') &&
      Object.keys(s).every((k) => k === 'name' || k === 'key'));
  if (!Array.isArray(raw.screens) || !raw.screens.every(screenOk)) {
    errors.push(
      '"screens" must be a list of flow names (lowercase, digits, "-") or { "name", "key": true }, e.g. ["settings", { "name": "shelf", "key": true }]',
    );
  }
  if (raw.easProfiles !== undefined) {
    const p = raw.easProfiles;
    if (!isRecord(p) || Object.values(p).some((v) => typeof v !== 'string' || !v)) {
      errors.push('"easProfiles" is { "qa": "<profile>", "release": "<profile>" }');
    }
  }
  if (raw.languages !== undefined) {
    const l = raw.languages;
    if (!isRecord(l) || !isStringArray(l.codes) || l.codes.length === 0) {
      errors.push('"languages.codes" must be a non-empty list, e.g. ["en", "fr"]');
    } else {
      const method = l.method ?? 'app-locale';
      if (method === 'flow' && typeof l.flow !== 'string') errors.push('"languages.method" "flow" needs "languages.flow"');
      else if (method === 'deep-link' && (typeof l.deepLink !== 'string' || !l.deepLink.includes('{lang}'))) {
        errors.push('"languages.method" "deep-link" needs "languages.deepLink" containing {lang}');
      } else if (!['app-locale', 'flow', 'deep-link'].includes(String(method))) {
        errors.push('"languages.method" is "app-locale", "flow" or "deep-link"');
      }
    }
  }
  if (raw.modes !== undefined && (!isStringArray(raw.modes) || !raw.modes.every((m) => m === 'light' || m === 'dark'))) {
    errors.push('"modes" is a subset of ["light", "dark"]');
  }
  if (
    raw.fontScales !== undefined &&
    (!Array.isArray(raw.fontScales) || !raw.fontScales.every((f) => typeof f === 'number' && f >= 0.85 && f <= 2))
  ) {
    errors.push('"fontScales" is a list of numbers between 0.85 and 2, e.g. [1.0, 1.3]');
  }
  if (raw.emulator !== undefined) {
    const e = raw.emulator;
    const ok =
      isRecord(e) &&
      ['avd', 'device', 'image'].every((k) => e[k] === undefined || (typeof e[k] === 'string' && /^[\w.;-]+$/.test(e[k] as string))) &&
      (e.ramMb === undefined || (typeof e.ramMb === 'number' && e.ramMb >= 1024)) &&
      (e.dataPartition === undefined || (typeof e.dataPartition === 'string' && /^\d+[MG]$/.test(e.dataPartition))) &&
      (e.gpu === undefined || (GPU_MODES as readonly unknown[]).includes(e.gpu)) &&
      (e.headless === undefined || typeof e.headless === 'boolean') &&
      ['minFreeMb', 'maxEmulatorMb'].every((k) => e[k] === undefined || (typeof e[k] === 'number' && (e[k] as number) >= 256));
    if (!ok) {
      errors.push(
        `"emulator" is { "avd", "device", "image", "ramMb" (≥ 1024), "dataPartition" ("8G"), "gpu" (${GPU_MODES.join(', ')}), ` +
          '"headless" (true/false), "minFreeMb", "maxEmulatorMb" (≥ 256) }, every key optional',
      );
    }
  }
  return errors;
}

export function loadConfig(root: string): KitConfig {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) fail(`No ${CONFIG_FILE} in ${root}. See the mobile-kit README → Adopting it in an app.`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`${CONFIG_FILE} is not valid JSON: ${(e as Error).message}`);
  }
  const errors = validateConfig(raw);
  if (errors.length) fail(`${CONFIG_FILE}:\n${errors.map((e) => `    - ${e}`).join('\n')}`);
  const c = raw as Record<string, unknown> & Omit<KitConfig, 'easProfiles' | 'languages' | 'modes' | 'fontScales'>;
  const profiles = (c.easProfiles ?? {}) as Partial<KitConfig['easProfiles']>;
  const languages = (c.languages ?? {}) as Partial<LanguageConfig>;
  return {
    appName: c.appName,
    androidPackage: c.androidPackage,
    apkName: c.apkName,
    r2Bucket: c.r2Bucket,
    r2Prefix: c.r2Prefix,
    downloadsHost: c.downloadsHost,
    signingSha1: c.signingSha1,
    maestroDir: c.maestroDir,
    screens: (c.screens as unknown as (string | { name: string; key?: boolean })[]).map((s) =>
      typeof s === 'string' ? { name: s, key: false } : { name: s.name, key: s.key ?? false },
    ),
    easProfiles: { qa: profiles.qa ?? 'preview', release: profiles.release ?? 'production' },
    languages: {
      codes: languages.codes ?? ['en', 'fr'],
      method: languages.method ?? 'app-locale',
      flow: languages.flow,
      deepLink: languages.deepLink,
      restore: languages.restore,
    },
    modes: (c.modes as KitConfig['modes'] | undefined) ?? ['light', 'dark'],
    fontScales: (c.fontScales as number[] | undefined) ?? [1.0, 1.3],
    emulator: { ...EMULATOR_DEFAULTS, ...((c.emulator as Partial<EmulatorConfig> | undefined) ?? {}) },
  };
}

export interface AppJson {
  version: string;
  /**
   * The versionCode pinned in app.json, or null when it is EAS's
   * (`appVersionSource: "remote"`): then the expected versionCode is read
   * from the build itself (the APK, or EAS's `appBuildVersion`).
   */
  versionCode: number | null;
  androidPackage: string;
}

/** `cli.appVersionSource` of eas.json, or null (no eas.json, not set, unreadable). */
function easVersionSource(root: string): string | null {
  const file = path.join(root, 'eas.json');
  if (!fs.existsSync(file)) return null;
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { cli?: { appVersionSource?: unknown } };
    return typeof json.cli?.appVersionSource === 'string' ? json.cli.appVersionSource : null;
  } catch {
    return null;
  }
}

/**
 * Version, versionCode and package of the Expo app.json. No
 * `expo.android.versionCode` means EAS numbers the builds (remote); one
 * that eas.json's `appVersionSource: "remote"` overrides is ignored.
 */
export function readAppJson(root: string): AppJson {
  const file = path.join(root, 'app.json');
  if (!fs.existsSync(file)) fail(`No app.json in ${root}`);
  let expo: Record<string, unknown>;
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { expo?: Record<string, unknown> };
    expo = json.expo ?? {};
  } catch (e) {
    fail(`app.json is not valid JSON: ${(e as Error).message}`);
  }
  const android = (expo.android ?? {}) as Record<string, unknown>;
  const { version } = expo;
  const { versionCode, package: androidPackage } = android;
  if (typeof version !== 'string') fail('app.json has no expo.version');
  if (versionCode !== undefined && (typeof versionCode !== 'number' || !Number.isInteger(versionCode))) {
    fail('app.json expo.android.versionCode is not a whole number');
  }
  if (typeof androidPackage !== 'string') fail('app.json has no expo.android.package');
  if (versionCode !== undefined && easVersionSource(root) === 'remote') {
    warn(`app.json expo.android.versionCode (${versionCode}) is ignored: eas.json sets appVersionSource "remote", EAS numbers the builds`);
    return { version, versionCode: null, androidPackage };
  }
  return { version, versionCode: versionCode ?? null, androidPackage };
}
