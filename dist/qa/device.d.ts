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
export declare function qaDevice(args: string[]): Promise<void>;
