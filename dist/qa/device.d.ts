import { type Project } from '../project.js';
import { type FlowResult, type QaRun } from './report.js';
export declare const QA_USAGE: string;
/** "Process system isn't responding" more than this many times: the device is saturated, the run stops. */
export declare const EMULATOR_SATURATED_AFTER = 3;
/** The state every run starts from (step 4); the emulator goes back to it at the end. */
export declare const KNOWN_STATE: {
    night: string;
    fontScale: string;
    animations: string[];
};
/** --migration-from: its two flows, relative to maestroDir. */
export declare const MIGRATION_FLOWS: {
    readonly seed: "migration/seed.yaml";
    readonly verify: "migration/verify-upgrade.yaml";
};
export interface QaOptions {
    apk?: string;
    skipBuild: boolean;
    /** Build the qa profile on this computer (build/local.ts) instead of EAS. */
    localBuild: boolean;
    emulator: boolean;
    /** A capture folder of an earlier run to continue. */
    resume?: string;
    /** With --resume: the smoke flows that failed run again (by default only those not run yet). */
    retryFailed: boolean;
    /** An older APK of the app: installed first, seeded, then upgraded to the APK under test. */
    migrationFrom?: string;
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
/** The smoke results a resumed run keeps: all of them, or only the passed ones with --retry-failed. */
export declare function keptSmoke(previous: FlowResult[], retryFailed: boolean): FlowResult[];
export declare function qaDevice(args: string[]): Promise<void>;
