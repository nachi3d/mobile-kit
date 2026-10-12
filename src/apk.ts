import fs from 'node:fs';
import { createHash } from 'node:crypto';

import { run } from './exec.js';
import { fail, info, warn } from './log.js';

/** An APK is a ZIP archive ("PK\x03\x04") holding AndroidManifest.xml. */
export function isApk(file: string): boolean {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const bytes = fs.readFileSync(file);
  return bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && bytes.includes('AndroidManifest.xml');
}

export const fileSize = (file: string) => fs.statSync(file).size;
export const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export interface ApkExpectation {
  androidPackage: string;
  version: string;
  versionCode: number;
  /** 40 lowercase hex digits. */
  sha1: string;
}

/**
 * Package, versionName, versionCode (aapt2) and signing certificate
 * (apksigner). Without build-tools: a clear warning, the rest goes on.
 */
export function verifyApk(file: string, expect: ApkExpectation, aapt: string[], apksigner: string[]): void {
  if (!isApk(file)) fail(`Not an APK: ${file}`);
  if (aapt.length === 0 || apksigner.length === 0) {
    warn(
      'Android build-tools (aapt2, apksigner) not found: package, version and signature NOT verified. ' +
        'Install them (Android Studio → SDK Manager → SDK Tools → Android SDK Build-Tools) or set ANDROID_HOME.',
    );
    return;
  }
  const badging = run(aapt, ['dump', 'badging', file]);
  const line = badging.stdout.split('\n').find((l) => l.startsWith('package:'));
  if (badging.status !== 0 || !line) fail(`aapt2 cannot read ${file}`);
  const field = (name: string) => new RegExp(` ${name}='([^']*)'`).exec(line)?.[1] ?? '';
  if (field('name') !== expect.androidPackage) fail(`Package is '${field('name')}', expected ${expect.androidPackage}`);
  if (field('versionName') !== expect.version) fail(`versionName is '${field('versionName')}', expected ${expect.version}`);
  if (field('versionCode') !== String(expect.versionCode)) {
    fail(`versionCode is '${field('versionCode')}', app.json says ${expect.versionCode}`);
  }
  const certs = run(apksigner, ['verify', '--print-certs', file]);
  if (certs.status !== 0) fail('apksigner: the APK is not signed or its signature is invalid');
  const sha1Line = `${certs.stdout}\n${certs.stderr}`.split('\n').find((l) => /certificate SHA-1 digest/i.test(l)) ?? '';
  const actual = sha1Line
    .replace(/.*:\s*/, '')
    .replace(/[:\s]/g, '')
    .toLowerCase();
  if (actual !== expect.sha1) {
    fail(`Signing certificate SHA-1 is '${actual}', mobile-kit.config.json says ${expect.sha1}. Wrong keystore: do not publish.`);
  }
  info(`APK OK: ${expect.androidPackage} ${expect.version} (${expect.versionCode}), signed with the expected key`);
}
