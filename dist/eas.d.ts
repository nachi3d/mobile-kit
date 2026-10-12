import type { Project } from './project.js';
export interface FinishedBuild {
    url: string;
    /** The versionCode EAS gave the build, or null when its JSON has none. */
    appBuildVersion: number | null;
}
/** The APK URL and versionCode of `eas build --json` output, or a stop. */
export declare function finishedBuild(json: string): FinishedBuild;
export interface EasBuildResult {
    /** False on a dry run: no new file. */
    downloaded: boolean;
    appBuildVersion: number | null;
}
/**
 * EAS build of `profile` (waits), downloaded to `dest`. Dry run: printed
 * only, nothing downloaded.
 */
export declare function easBuild(p: Project, profile: string, dest: string): EasBuildResult;
/**
 * The versionCode of the latest FINISHED Android build of `profile` on EAS
 * (read-only, so it runs on a dry run too), or a stop.
 */
export declare function latestBuildVersion(p: Project, profile: string): number;
