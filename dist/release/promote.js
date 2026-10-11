// mk release:promote <version> [--dry-run]
//
// Step 2 of 2 of a release, after the phone check: makes <version> the
// download behind latest.apk, purges both URLs from the Cloudflare cache
// and checks what the public now gets.
//
// --dry-run runs every check and the confirmation, but only PRINTS the
// upload and the purge (token hidden); the final check is skipped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileSize, isApk } from '../apk.js';
import { act, run } from '../exec.js';
import { httpHead, originHead } from '../http.js';
import { detail, fail, info } from '../log.js';
import { loadEnvLocal, openProject } from '../project.js';
import { confirm } from '../prompt.js';
import { APK_TYPE, CACHE_LATEST, LATEST_MAX_AGE_LIMIT, parseVersion, releaseTarget } from './common.js';
export const PROMOTE_USAGE = 'Usage: mk release:promote <version> [--dry-run]';
export async function releasePromote(args, dryRun) {
    const version = parseVersion(args, PROMOTE_USAGE);
    const p = openProject({ dryRun, requireDryRunInFixture: true });
    const t = releaseTarget(p, version);
    const rel = `dist/${t.apkFile}`;
    // --- Preconditions ---------------------------------------------------------
    const env = loadEnvLocal(p.root);
    if (!env.cfZoneId)
        fail('CF_ZONE_ID is missing in .env.local');
    if (!env.cfPurgeToken)
        fail('CF_PURGE_TOKEN is missing in .env.local');
    if (!isApk(t.apkPath))
        fail(`No APK at ${rel} (run release:build first)`);
    const localSize = String(fileSize(t.apkPath));
    const head = originHead(p.tool.curl, t.versionedUrl);
    if (head.status !== '200')
        fail(`${t.versionedKey} is not on R2 (HTTP '${head.status}'). Run release:build first.`);
    const remoteSize = head.header('content-length');
    if (remoteSize !== localSize) {
        fail(`${t.versionedKey} is ${remoteSize} bytes on R2 but ${rel} is ${localSize}: not the same file.`);
    }
    info(`${t.versionedKey} on R2 matches ${rel} (${localSize} bytes)`);
    // --- Confirm ---------------------------------------------------------------
    if (!(await confirm(`Promote ${version} to latest?`)))
        fail('Not promoted. latest.apk is unchanged.');
    // --- Upload latest.apk -----------------------------------------------------
    info(`Uploading ${p.config.r2Bucket}/${t.latestKey}`);
    const upload = act(p.dryRun, p.tool.wrangler, [
        'r2', 'object', 'put', `${p.config.r2Bucket}/${t.latestKey}`, '--remote',
        '--file', t.apkPath, '--content-type', APK_TYPE, '--cache-control', CACHE_LATEST,
    ], { cwd: p.root });
    if (upload.status !== 0)
        fail(`Upload failed: ${t.latestKey}`);
    // --- Purge the Cloudflare cache --------------------------------------------
    const purgeUrl = `https://api.cloudflare.com/client/v4/zones/${env.cfZoneId}/purge_cache`;
    const body = JSON.stringify({ files: [t.versionedUrl, t.latestUrl] });
    info('Purging both URLs from the Cloudflare cache');
    if (p.dryRun) {
        detail(`[dry run, not executed] curl -X POST ${purgeUrl} -H 'Authorization: Bearer ***' --data '${body}'`);
    }
    else {
        // The token goes through a private header file, never the command line.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-purge-'));
        const headerFile = path.join(dir, 'headers');
        try {
            fs.writeFileSync(headerFile, `Authorization: Bearer ${env.cfPurgeToken}\nContent-Type: application/json\n`, { mode: 0o600 });
            const r = run(p.tool.curl, ['-sS', '-X', 'POST', purgeUrl, '-H', `@${headerFile}`, '--data', body]);
            if (!/"success":\s*true/.test(r.stdout)) {
                fail(`Cache purge failed. Purge both URLs in the dashboard (mobile-kit README → Cloudflare). Cloudflare said: ${r.stdout.slice(0, 300)}`);
            }
        }
        finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    // --- Verify what the public gets -------------------------------------------
    if (p.dryRun) {
        info('Dry run: the final check would be:');
        detail(`curl -I ${t.versionedUrl}`);
        detail(`curl -I ${t.latestUrl}`);
        return;
    }
    info('Checking the public URLs');
    const check = (url) => {
        const h = httpHead(p.tool.curl, url);
        if (h.status !== '200')
            fail(`${url}: HTTP '${h.status}', expected 200`);
        if (h.header('content-type') !== APK_TYPE)
            fail(`${url}: Content-Type '${h.header('content-type')}', expected ${APK_TYPE}`);
        if (h.header('content-length') !== localSize) {
            fail(`${url}: Content-Length ${h.header('content-length')}, expected ${localSize}`);
        }
        detail(`OK ${url}`);
        return h;
    };
    check(t.versionedUrl);
    const latest = check(t.latestUrl);
    const cache = latest.header('cache-control');
    const maxAge = /max-age=(\d+)/i.exec(cache)?.[1];
    if (maxAge && Number(maxAge) > LATEST_MAX_AGE_LIMIT) {
        fail(`latest.apk is served with Cache-Control '${cache}': phones may get an old version. ` +
            'Fix the Cloudflare cache rules (mobile-kit README → Cloudflare).');
    }
    detail(`OK latest.apk Cache-Control: ${cache || 'none'}`);
    info(`${p.config.appName} ${version} is live: ${t.latestUrl}`);
}
