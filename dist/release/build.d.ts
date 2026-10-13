export declare const BUILD_USAGE = "Usage: mk release:build <version> [--local] [--dry-run]";
export declare function releaseBuild(args: string[], dryRun: boolean, local?: boolean): Promise<void>;
