import { type Project } from '../project.js';
export declare const LOCAL_BUILD_USAGE = "Usage: mk build --local --profile <eas profile> [--dry-run]";
/** Below this much free RAM a local build is not started (Gradle 3 GB + Metro + the system). */
export declare const MIN_BUILD_FREE_MB = 4096;
/** The generated build.gradle's release signing, pointed at these variables. */
export declare const SIGNING_ENV: {
    readonly storeFile: "MK_SIGNING_STORE_FILE";
    readonly storePassword: "MK_SIGNING_STORE_PASSWORD";
    readonly keyAlias: "MK_SIGNING_KEY_ALIAS";
    readonly keyPassword: "MK_SIGNING_KEY_PASSWORD";
};
/**
 * Expo's generated app/build.gradle signs release builds with the debug key.
 * Adds a signing config read from the environment and uses it for release.
 */
export declare function patchBuildGradle(text: string): string;
/** gradle.properties with mk's memory settings set (replaced when present). */
export declare function patchGradleProperties(text: string): string;
export interface LocalBuildOptions {
    /** Where the APK goes; default dist/<apkName>-<version>-<profile>.apk. */
    dest?: string;
    /** Verify the APK here (release:build verifies it itself). Default true. */
    verify?: boolean;
}
export interface LocalBuildResult {
    apk: string;
    /** False on a dry run: nothing built. */
    built: boolean;
}
export declare function localBuildPath(p: Project, profile: string): string;
/** Builds `profile` locally (see the top of this file). */
export declare function localBuild(p: Project, profile: string, options?: LocalBuildOptions): LocalBuildResult;
/** `mk build --local --profile <name> [--dry-run]`. */
export declare function buildCommand(args: string[]): Promise<void>;
