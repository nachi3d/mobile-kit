/** An APK is a ZIP archive ("PK\x03\x04") holding AndroidManifest.xml. */
export declare function isApk(file: string): boolean;
export declare const fileSize: (file: string) => number;
export declare const sha256: (file: string) => string;
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
export declare function verifyApk(file: string, expect: ApkExpectation, aapt: string[], apksigner: string[]): void;
