import { type RunResult } from './exec.js';
export declare const DEVICE_HELP = "Connect exactly one Android device or emulator:\n    - Phone: Settings \u2192 About phone \u2192 tap \"Build number\" 7 times; then\n      Settings \u2192 System \u2192 Developer options \u2192 USB debugging ON. Plug it in\n      and accept \"Allow USB debugging?\" on the phone.\n    - Emulator: Android Studio \u2192 Device Manager \u2192 start one.\n    - Check with: adb devices   (one line ending in \"device\")\n    - Several listed? Unplug phones / stop emulators until one is left.";
export interface DeviceList {
    ready: string[];
    /** serial → state, for "unauthorized", "offline", … */
    other: [string, string][];
}
export declare function listDevices(adb: string[]): DeviceList;
/** The one ready device, or a stop with help. */
export declare function requireOneDevice(adb: string[]): string;
/** adb -s <serial> shell <args>: stdout, trimmed. */
export declare function shell(adb: string[], serial: string, args: string[]): string;
export declare function shellAct(dryRun: boolean, adb: string[], serial: string, args: string[]): RunResult;
export declare function installedVersionCode(adb: string[], serial: string, pkg: string): number | null;
export interface DeviceInfo {
    serial: string;
    model: string;
    manufacturer: string;
    androidVersion: string;
    sdk: number;
}
export declare function deviceInfo(adb: string[], serial: string): DeviceInfo;
/** `cmd uimode night` prints "Night mode: no" (or yes, auto, custom…). */
export declare function getNightMode(adb: string[], serial: string): string;
/** "null" when never set (the system default, 1.0). */
export declare function getFontScale(adb: string[], serial: string): string;
export declare function setFontScaleArgs(value: string): string[];
/** Android 13+: "Locales for <pkg> for user 0 are [fr-FR]" → "fr-FR" ("" = follows the system). */
export declare function getAppLocales(adb: string[], serial: string, pkg: string): string;
/** An empty list puts the app back on the system language. */
export declare function setAppLocalesArgs(pkg: string, locales: string): string[];
/** The current screen as PNG bytes, or null. */
export declare function screencap(adb: string[], serial: string): Buffer | null;
/** Package of the ANR dialog that has the focus, or null. */
export declare function focusedAnr(adb: string[], serial: string): string | null;
/** Centre of the dialog's Wait button (android:id/aerr_wait) in a uiautomator dump. */
export declare function waitButtonCentre(xml: string): [number, number] | null;
/**
 * Another app's ANR dialog (e.g. "Pixel Launcher isn't responding" after a
 * cold boot) covers the app and fails every flow: tap its Wait button. An
 * ANR of the app under test is left alone; it is a finding. Returns a note
 * for the report, or null when there was nothing to do.
 */
export declare function dismissForeignAnr(dryRun: boolean, adb: string[], serial: string, appPackage: string): string | null;
