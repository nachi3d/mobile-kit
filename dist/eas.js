import fs from 'node:fs';
import path from 'node:path';
import { act, run } from './exec.js';
import { fail, info } from './log.js';
/** The APK URL of `eas build --json` output, or a stop. */
export function artifactUrl(json) {
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        fail('EAS did not print JSON');
    }
    const build = (Array.isArray(parsed) ? parsed[0] : parsed);
    if (!build || build.status !== 'FINISHED')
        fail(`EAS build status: ${build?.status ?? 'none'}`);
    const url = build.artifacts?.applicationArchiveUrl ?? build.artifacts?.buildUrl;
    if (!url)
        fail('No APK URL in the EAS build result');
    return url;
}
/**
 * EAS build of `profile` (waits), downloaded to `dest`. Dry run: printed
 * only; returns false (no new file).
 */
export function easBuild(p, profile, dest) {
    info(`EAS build (profile ${profile}). This waits until the build is done.`);
    const args = ['build', '-p', 'android', '--profile', profile, '--non-interactive', '--wait', '--json'];
    if (p.dryRun) {
        act(true, p.tool.eas, args);
        return false;
    }
    const r = run(p.tool.eas, args, { cwd: p.root, liveStderr: true });
    if (r.status !== 0)
        fail('EAS build failed (see above)');
    const url = artifactUrl(r.stdout);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = path.join(path.dirname(dest), `.download-${path.basename(dest)}`);
    info(`Downloading the APK to ${path.relative(p.root, dest)}`);
    if (run(p.tool.curl, ['-fsSL', '-o', tmp, url]).status !== 0)
        fail(`Download failed: ${url}`);
    fs.renameSync(tmp, dest);
    return true;
}
