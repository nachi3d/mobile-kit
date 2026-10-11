export declare const CONFIG_FILE = "mobile-kit.config.json";
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
    easProfiles: {
        qa: string;
        release: string;
    };
    languages: LanguageConfig;
    /** Default ["light", "dark"]. */
    modes: ('light' | 'dark')[];
    /** Android font scales. Default [1.0, 1.3]. */
    fontScales: number[];
}
/** "AA:BB:…" or 40 hex digits → 40 lowercase hex digits, or null. */
export declare function normalizeSha1(value: string): string | null;
/** Every problem of a parsed config, or [] when it is valid. */
export declare function validateConfig(raw: unknown): string[];
export declare function loadConfig(root: string): KitConfig;
export interface AppJson {
    version: string;
    versionCode: number;
    androidPackage: string;
}
/** Version, versionCode and package of the Expo app.json. */
export declare function readAppJson(root: string): AppJson;
