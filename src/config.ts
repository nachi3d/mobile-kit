import fs from 'node:fs';
import path from 'node:path';

import { fail } from './log.js';

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
  /** Screen flows to screenshot: <maestroDir>/screens/<name>.yaml */
  screens: string[];
  /** EAS build profiles. Defaults: qa "preview", release "production". */
  easProfiles: { qa: string; release: string };
  languages: LanguageConfig;
  /** Default ["light", "dark"]. */
  modes: ('light' | 'dark')[];
  /** Android font scales. Default [1.0, 1.3]. */
  fontScales: number[];
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
  if (!isStringArray(raw.screens) || !raw.screens.every((n) => /^[a-z0-9][a-z0-9-]*$/.test(n))) {
    errors.push('"screens" must be a list of flow names (lowercase, digits, "-"), e.g. ["shelf", "settings"]');
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
    screens: c.screens,
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
  };
}

export interface AppJson {
  version: string;
  versionCode: number;
  androidPackage: string;
}

/** Version, versionCode and package of the Expo app.json. */
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
  if (typeof versionCode !== 'number') fail('app.json has no expo.android.versionCode');
  if (typeof androidPackage !== 'string') fail('app.json has no expo.android.package');
  return { version, versionCode, androidPackage };
}
