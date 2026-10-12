import path from 'node:path';

import { normalizeSha1 } from '../config.js';
import { fail } from '../log.js';
import type { Project } from '../project.js';

export const APK_TYPE = 'application/vnd.android.package-archive';
export const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
export const CACHE_LATEST = 'no-cache';
/** A longer max-age on latest.apk means phones can get an old version. */
export const LATEST_MAX_AGE_LIMIT = 60;

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

export function parseVersion(args: string[], usage: string): string {
  if (args.length !== 1 || !args[0]) fail(usage);
  const version = args[0];
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`Not a version (x.y.z): ${version}`);
  return version;
}

/** Keys and URLs of a release; the version must be app.json's. */
export function releaseTarget(p: Project, version: string): ReleaseTarget {
  if (version !== p.app.version) fail(`Version ${version} does not match app.json (${p.app.version})`);
  const { apkName, r2Prefix, downloadsHost } = p.config;
  const apkFile = `${apkName}-${version}.apk`;
  const versionedKey = `${r2Prefix}/${version}/${apkFile}`;
  const latestKey = `${r2Prefix}/latest.apk`;
  return {
    version,
    versionCode: p.app.versionCode,
    apkFile,
    apkPath: path.join(p.root, 'dist', apkFile),
    versionedKey,
    latestKey,
    versionedUrl: `https://${downloadsHost}/${versionedKey}`,
    latestUrl: `https://${downloadsHost}/${latestKey}`,
    sha1: normalizeSha1(p.config.signingSha1) ?? '',
  };
}
