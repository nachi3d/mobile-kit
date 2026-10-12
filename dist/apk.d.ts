/** An APK is a ZIP archive ("PK\x03\x04") holding AndroidManifest.xml. */
export declare function isApk(file: string): boolean;
export declare const fileSize: (file: string) => number;
export declare const sha256: (file: string) => string;
export interface Badging {
    androidPackage: string;
    versionName: string;
    versionCode: number;
}
/** Package, versionName and versionCode of an APK (aapt2), or null without build-tools. */
export declare function readBadging(file: string, aapt: string[]): Badging | null;
export interface ApkExpectation {
    androidPackage: string;
    version: string;
    /** null: not known in advance (remote versionCode, nothing built yet); the APK's is reported. */
    versionCode: number | null;
    /** Where `versionCode` comes from, for messages: "app.json", "the EAS build", … */
    versionCodeFrom: string;
    /** 40 lowercase hex digits. */
    sha1: string;
}
/**
 * Package, versionName, versionCode (aapt2) and signing certificate
 * (apksigner). Returns the APK's versionCode. Without build-tools: a clear
 * warning, the rest goes on, and null.
 */
export declare function verifyApk(file: string, expect: ApkExpectation, aapt: string[], apksigner: string[]): number | null;
