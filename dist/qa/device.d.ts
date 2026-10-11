export declare const QA_USAGE = "Usage: mk qa:device [--apk <path>] [--skip-build] [--emulator] [--yes] [--no-open] [--dry-run]";
export interface QaOptions {
    apk?: string;
    skipBuild: boolean;
    emulator: boolean;
    yes: boolean;
    open: boolean;
    dryRun: boolean;
}
export declare function parseQaArgs(args: string[]): QaOptions;
export declare function qaDevice(args: string[]): Promise<void>;
