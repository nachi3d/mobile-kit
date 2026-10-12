import type { Project } from '../project.js';
export declare const APK_TYPE = "application/vnd.android.package-archive";
export declare const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
export declare const CACHE_LATEST = "no-cache";
/** A longer max-age on latest.apk means phones can get an old version. */
export declare const LATEST_MAX_AGE_LIMIT = 60;
export interface ReleaseTarget {
    version: string;
    /** app.json's, or null when EAS numbers the builds (read from the build). */
    versionCode: number | null;
    apkFile: string;
    apkPath: string;
    versionedKey: string;
    latestKey: string;
    versionedUrl: string;
    latestUrl: string;
    sha1: string;
}
export declare function parseVersion(args: string[], usage: string): string;
/** Keys and URLs of a release; the version must be app.json's. */
export declare function releaseTarget(p: Project, version: string): ReleaseTarget;
