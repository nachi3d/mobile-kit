import { type Project } from '../project.js';
import { type QaRun } from './report.js';
export declare const QA_USAGE = "Usage: mk qa:device [--apk <path>] [--skip-build] [--emulator] [--resume <dir>] [--keep-emulator] [--yes] [--no-open] [--dry-run]";
export interface QaOptions {
    apk?: string;
    skipBuild: boolean;
    emulator: boolean;
    /** A capture folder of an earlier run to continue. */
    resume?: string;
    /** Leave the emulator running at the end (by default mk stops one it started). */
    keepEmulator: boolean;
    yes: boolean;
    open: boolean;
    dryRun: boolean;
}
export declare function parseQaArgs(args: string[]): QaOptions;
/** Maestro's on-device driver: uninstalled, Maestro installs it again on its next run. */
export declare const MAESTRO_DRIVER: string[];
export interface ExpectedVersionCode {
    /** null: unknown, on a dry run only (nothing built yet). */
    versionCode: number | null;
    /** Where it comes from, for messages and the report. */
    from: string;
}
/**
 * The versionCode the device must have after the install. app.json's when
 * the app pins one; otherwise the build's: the resumed run's, the APK's
 * (aapt2) checked against EAS's appBuildVersion when mk built it, or the
 * latest finished EAS build of the qa profile (--skip-build).
 */
export declare function expectedVersionCode(p: Project, o: QaOptions, s: {
    apk: string | null;
    builtVc: number | null;
    previous: QaRun | null;
}): ExpectedVersionCode;
export declare function qaDevice(args: string[]): Promise<void>;
