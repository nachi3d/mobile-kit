import fs from 'node:fs';
import path from 'node:path';

import { act, run } from './exec.js';
import { fail, info } from './log.js';
import type { Project } from './project.js';

interface EasBuildJson {
  status?: string;
  appBuildVersion?: string | number | null;
  artifacts?: { applicationArchiveUrl?: string; buildUrl?: string };
}

/** The first build of `eas build … --json` / `eas build:list … --json` output, or a stop. */
function firstBuild(json: string): EasBuildJson | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    fail('EAS did not print JSON');
  }
  return (Array.isArray(parsed) ? parsed[0] : parsed) as EasBuildJson | undefined;
}

/** EAS's versionCode of a build (`appBuildVersion`, a string in EAS's JSON), or null. */
function buildVersion(build: EasBuildJson): number | null {
  const v = String(build.appBuildVersion ?? '');
  return /^\d+$/.test(v) ? Number(v) : null;
}

export interface FinishedBuild {
  url: string;
  /** The versionCode EAS gave the build, or null when its JSON has none. */
  appBuildVersion: number | null;
}

/** The APK URL and versionCode of `eas build --json` output, or a stop. */
export function finishedBuild(json: string): FinishedBuild {
  const build = firstBuild(json);
  if (!build || build.status !== 'FINISHED') fail(`EAS build status: ${build?.status ?? 'none'}`);
  const url = build.artifacts?.applicationArchiveUrl ?? build.artifacts?.buildUrl;
  if (!url) fail('No APK URL in the EAS build result');
  return { url, appBuildVersion: buildVersion(build) };
}

export interface EasBuildResult {
  /** False on a dry run: no new file. */
  downloaded: boolean;
  appBuildVersion: number | null;
}

/**
 * EAS build of `profile` (waits), downloaded to `dest`. Dry run: printed
 * only, nothing downloaded.
 */
export function easBuild(p: Project, profile: string, dest: string): EasBuildResult {
  info(`EAS build (profile ${profile}). This waits until the build is done.`);
  const args = ['build', '-p', 'android', '--profile', profile, '--non-interactive', '--wait', '--json'];
  if (p.dryRun) {
    act(true, p.tool.eas, args);
    return { downloaded: false, appBuildVersion: null };
  }
  const r = run(p.tool.eas, args, { cwd: p.root, liveStderr: true });
  if (r.status !== 0) fail('EAS build failed (see above)');
  const { url, appBuildVersion } = finishedBuild(r.stdout);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.download-${path.basename(dest)}`);
  info(`Downloading the APK to ${path.relative(p.root, dest)}${appBuildVersion !== null ? ` (EAS versionCode ${appBuildVersion})` : ''}`);
  if (run(p.tool.curl, ['-fsSL', '-o', tmp, url]).status !== 0) fail(`Download failed: ${url}`);
  fs.renameSync(tmp, dest);
  return { downloaded: true, appBuildVersion };
}

/**
 * The versionCode of the latest FINISHED Android build of `profile` on EAS
 * (read-only, so it runs on a dry run too), or a stop.
 */
export function latestBuildVersion(p: Project, profile: string): number {
  const args = ['build:list', '-p', 'android', '--build-profile', profile, '--status', 'finished', '--limit', '1', '--json', '--non-interactive'];
  const r = run(p.tool.eas, args, { cwd: p.root });
  if (r.status !== 0) fail(`eas build:list failed: cannot read the versionCode of the latest ${profile} build (network? EXPO_TOKEN?)`);
  const build = firstBuild(r.stdout);
  if (!build) fail(`EAS has no finished Android build of profile ${profile}`);
  const vc = buildVersion(build);
  if (vc === null) fail(`EAS's latest ${profile} build has no appBuildVersion`);
  return vc;
}

interface EasProfileJson {
  extends?: string;
  env?: Record<string, unknown>;
}

/**
 * The `env` of an eas.json build profile with its `extends` chain applied,
 * as EAS merges it (the child wins). A local build sets the same variables
 * (e.g. the ABIs an app builds), so it builds what EAS would.
 */
export function easProfileEnv(root: string, profile: string): Record<string, string> {
  const file = path.join(root, 'eas.json');
  if (!fs.existsSync(file)) fail('No eas.json: a local build takes its profile (env) from eas.json');
  let profiles: Record<string, EasProfileJson>;
  try {
    profiles = (JSON.parse(fs.readFileSync(file, 'utf8')) as { build?: Record<string, EasProfileJson> }).build ?? {};
  } catch (e) {
    fail(`eas.json is not valid JSON: ${(e as Error).message}`);
  }
  const seen: string[] = [];
  const resolve = (name: string): Record<string, string> => {
    if (seen.includes(name)) fail(`eas.json: profiles extend each other in a loop (${[...seen, name].join(' → ')})`);
    seen.push(name);
    const entry = profiles[name];
    if (!entry) fail(`eas.json has no build profile "${name}" (profiles: ${Object.keys(profiles).join(', ') || 'none'})`);
    const parent = entry.extends ? resolve(entry.extends) : {};
    const own = Object.fromEntries(Object.entries(entry.env ?? {}).map(([k, v]) => [k, String(v)]));
    return { ...parent, ...own };
  };
  return resolve(profile);
}
