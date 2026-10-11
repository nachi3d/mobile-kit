import type { Project } from './project.js';
/** The APK URL of `eas build --json` output, or a stop. */
export declare function artifactUrl(json: string): string;
/**
 * EAS build of `profile` (waits), downloaded to `dest`. Dry run: printed
 * only; returns false (no new file).
 */
export declare function easBuild(p: Project, profile: string, dest: string): boolean;
