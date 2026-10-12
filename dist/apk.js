import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { run } from './exec.js';
import { fail, info, warn } from './log.js';
/** An APK is a ZIP archive ("PK\x03\x04") holding AndroidManifest.xml. */
export function isApk(file) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
        return false;
    const bytes = fs.readFileSync(file);
    return bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && bytes.includes('AndroidManifest.xml');
}
export const fileSize = (file) => fs.statSync(file).size;
export const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** Package, versionName and versionCode of an APK (aapt2), or null without build-tools. */
export function readBadging(file, aapt) {
    if (aapt.length === 0)
        return null;
    const badging = run(aapt, ['dump', 'badging', file]);
    const line = badging.stdout.split('\n').find((l) => l.startsWith('package:'));
    if (badging.status !== 0 || !line)
        fail(`aapt2 cannot read ${file}`);
    const field = (name) => new RegExp(` ${name}='([^']*)'`).exec(line)?.[1] ?? '';
    const versionCode = Number(field('versionCode'));
    if (!/^\d+$/.test(field('versionCode')))
        fail(`aapt2: no versionCode in ${file}`);
    return { androidPackage: field('name'), versionName: field('versionName'), versionCode };
}
/**
 * Package, versionName, versionCode (aapt2) and signing certificate
 * (apksigner). Returns the APK's versionCode. Without build-tools: a clear
 * warning, the rest goes on, and null.
 */
export function verifyApk(file, expect, aapt, apksigner) {
    if (!isApk(file))
        fail(`Not an APK: ${file}`);
    if (aapt.length === 0 || apksigner.length === 0) {
        warn('Android build-tools (aapt2, apksigner) not found: package, version and signature NOT verified. ' +
            'Install them (Android Studio → SDK Manager → SDK Tools → Android SDK Build-Tools) or set ANDROID_HOME.');
        return null;
    }
    const apk = readBadging(file, aapt);
    if (apk.androidPackage !== expect.androidPackage)
        fail(`Package is '${apk.androidPackage}', expected ${expect.androidPackage}`);
    if (apk.versionName !== expect.version)
        fail(`versionName is '${apk.versionName}', expected ${expect.version}`);
    if (expect.versionCode !== null && apk.versionCode !== expect.versionCode) {
        fail(`versionCode is '${apk.versionCode}', ${expect.versionCodeFrom} says ${expect.versionCode}`);
    }
    const certs = run(apksigner, ['verify', '--print-certs', file]);
    if (certs.status !== 0)
        fail('apksigner: the APK is not signed or its signature is invalid');
    const sha1Line = `${certs.stdout}\n${certs.stderr}`.split('\n').find((l) => /certificate SHA-1 digest/i.test(l)) ?? '';
    const actual = sha1Line
        .replace(/.*:\s*/, '')
        .replace(/[:\s]/g, '')
        .toLowerCase();
    if (actual !== expect.sha1) {
        fail(`Signing certificate SHA-1 is '${actual}', mobile-kit.config.json says ${expect.sha1}. Wrong keystore: do not publish.`);
    }
    info(`APK OK: ${expect.androidPackage} ${expect.version} (${apk.versionCode}), signed with the expected key`);
    return apk.versionCode;
}
