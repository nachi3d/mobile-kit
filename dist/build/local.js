// mk build --local --profile <name> [--dry-run]
//
// A release APK built on this computer instead of EAS (no build quota),
// signed with the PRODUCTION key, so it installs over the published app and
// can be published itself:
//   1. checks: the profile in eas.json, app.json pins its versionCode, the
//      production key in MK_KEYSTORE_DIR (certificate = signingSha1), android/
//      gitignored, at least MIN_BUILD_FREE_MB of free RAM;
//   2. `expo prebuild --platform android --clean --no-install` with the
//      profile's env (eas.json, `extends` applied): android/ is generated;
//      package.json and app.json are put back byte for byte if prebuild
//      touched them, and no tracked file may differ afterwards;
//   3. in the generated (gitignored) android/ only: release signing reads
//      the key from MK_SIGNING_* environment variables, Gradle gets 3 GB and
//      2 workers;
//   4. `gradlew assembleRelease --no-daemon --max-workers=2` with the
//      passwords in its environment only;
//   5. the APK goes to dist/<apkName>-<version>-<profile>.apk (or `dest`),
//      android/ is deleted, and the APK is verified: package, versionName,
//      versionCode, signing certificate SHA-1. A wrong APK is deleted.
//
// --dry-run runs every check (including the key) and prints the rest.
import fs from 'node:fs';
import path from 'node:path';
import { verifyApk } from '../apk.js';
import { normalizeSha1 } from '../config.js';
import { easProfileEnv } from '../eas.js';
import { act, run } from '../exec.js';
import { hostMemory } from '../host.js';
import { loadSigning } from '../keystore.js';
import { detail, fail, info, warn } from '../log.js';
import { openProject } from '../project.js';
export const LOCAL_BUILD_USAGE = 'Usage: mk build --local --profile <eas profile> [--dry-run]';
/** Below this much free RAM a local build is not started (Gradle 3 GB + Metro + the system). */
export const MIN_BUILD_FREE_MB = 4096;
/** The generated build.gradle's release signing, pointed at these variables. */
export const SIGNING_ENV = {
    storeFile: 'MK_SIGNING_STORE_FILE',
    storePassword: 'MK_SIGNING_STORE_PASSWORD',
    keyAlias: 'MK_SIGNING_KEY_ALIAS',
    keyPassword: 'MK_SIGNING_KEY_PASSWORD',
};
const GRADLE_PROPERTIES = {
    'org.gradle.jvmargs': '-Xmx3g -XX:MaxMetaspaceSize=768m -Dfile.encoding=UTF-8',
    'org.gradle.workers.max': '2',
    'org.gradle.parallel': 'false',
    'org.gradle.daemon': 'false',
    'kotlin.compiler.execution.strategy': 'in-process',
};
const GRADLE_ARGS = ['assembleRelease', '--no-daemon', '--max-workers=2', '-Pkotlin.compiler.execution.strategy=in-process'];
const RELEASE_SIGNING = `        mkRelease {
            storeFile file(System.getenv("${SIGNING_ENV.storeFile}"))
            storePassword System.getenv("${SIGNING_ENV.storePassword}")
            keyAlias System.getenv("${SIGNING_ENV.keyAlias}")
            keyPassword System.getenv("${SIGNING_ENV.keyPassword}")
        }
`;
/**
 * Expo's generated app/build.gradle signs release builds with the debug key.
 * Adds a signing config read from the environment and uses it for release.
 */
export function patchBuildGradle(text) {
    const configs = text.indexOf('signingConfigs {');
    const types = text.indexOf('buildTypes {');
    const release = types < 0 ? -1 : text.indexOf('release {', types);
    const use = release < 0 ? -1 : text.indexOf('signingConfig signingConfigs.debug', release);
    if (configs < 0 || types < 0 || release < 0 || use < 0) {
        fail('android/app/build.gradle does not have the expected signingConfigs / buildTypes.release (Expo template changed?)');
    }
    // After the line break (LF or CRLF) that ends `signingConfigs {`.
    const afterConfigs = text.indexOf('\n', configs) + 1;
    const patched = text.slice(0, use) + 'signingConfig signingConfigs.mkRelease' + text.slice(use + 'signingConfig signingConfigs.debug'.length);
    return patched.slice(0, afterConfigs) + RELEASE_SIGNING + patched.slice(afterConfigs);
}
/** gradle.properties with mk's memory settings set (replaced when present). */
export function patchGradleProperties(text) {
    const lines = text.split('\n').filter((l) => !Object.keys(GRADLE_PROPERTIES).some((k) => l.trim().startsWith(`${k}=`)));
    return [...lines, '# mobile-kit local build: fits a 16 GB PC', ...Object.entries(GRADLE_PROPERTIES).map(([k, v]) => `${k}=${v}`), ''].join('\n');
}
const gitStatus = (root) => run(['git'], ['-C', root, 'status', '--porcelain']).stdout;
/** Files prebuild may rewrite (e.g. package.json scripts → expo run:android): put back afterwards. */
const RESTORED = ['package.json', 'app.json'];
function freeRamCheck(p) {
    const mem = hostMemory(p);
    if (!mem) {
        warn('Cannot read free RAM: the memory check is skipped');
        return;
    }
    if (mem.freeMb < MIN_BUILD_FREE_MB) {
        fail(`Only ${mem.freeMb} MB of RAM free; a local build needs ${MIN_BUILD_FREE_MB} MB. ` +
            'Close Brave (and other browsers), Android Studio, a running emulator and other Node/Java processes, then try again.');
    }
    info(`Free RAM: ${mem.freeMb} MB (minimum ${MIN_BUILD_FREE_MB} MB)`);
}
export function localBuildPath(p, profile) {
    return path.join(p.root, 'dist', `${p.config.apkName}-${p.app.version}-${profile}.apk`);
}
/** Builds `profile` locally (see the top of this file). */
export function localBuild(p, profile, options = {}) {
    const dest = options.dest ?? localBuildPath(p, profile);
    const rel = path.relative(p.root, dest).replace(/\\/g, '/');
    info(`Local build of profile ${profile} → ${rel}`);
    // --- Checks, before anything is generated ----------------------------------
    const profileEnv = easProfileEnv(p.root, profile);
    if (p.app.versionCode === null) {
        fail('app.json has no expo.android.versionCode (EAS numbers this app’s builds remotely): a local build cannot know it. ' +
            'Pin the versionCode in app.json, or build on EAS.');
    }
    const signing = loadSigning(p);
    const android = path.join(p.root, 'android');
    if (run(['git'], ['-C', p.root, 'check-ignore', '-q', 'android/app/build.gradle']).status !== 0) {
        fail('android/ is not gitignored in this app: add "/android" to .gitignore (prebuild generates it).');
    }
    freeRamCheck(p);
    const envText = Object.keys(profileEnv).length ? Object.entries(profileEnv).map(([k, v]) => `${k}=${v}`).join(' ') : 'none';
    info(`Profile env (eas.json): ${envText}`);
    const buildEnv = { ...process.env, ...profileEnv, NODE_ENV: 'production', CI: '1' };
    const before = gitStatus(p.root);
    const saved = new Map(RESTORED.map((f) => [f, fs.existsSync(path.join(p.root, f)) ? fs.readFileSync(path.join(p.root, f)) : null]));
    const putBack = () => {
        for (const [f, bytes] of saved) {
            const file = path.join(p.root, f);
            if (bytes !== null && (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)))
                fs.writeFileSync(file, bytes);
        }
    };
    const started = Date.now();
    let built = false;
    const out = path.join(android, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
    try {
        // --- Prebuild ------------------------------------------------------------
        info('expo prebuild (android/, clean)');
        const prebuild = act(p.dryRun, p.tool.expo, ['prebuild', '--platform', 'android', '--clean', '--no-install'], {
            cwd: p.root,
            env: buildEnv,
            live: true,
        });
        if (prebuild.status !== 0)
            fail('expo prebuild failed (see above)');
        if (!p.dryRun) {
            putBack();
            const gradleFile = path.join(android, 'app', 'build.gradle');
            if (!fs.existsSync(gradleFile))
                fail('prebuild made no android/app/build.gradle (a Kotlin build.gradle.kts is not supported)');
            fs.writeFileSync(gradleFile, patchBuildGradle(fs.readFileSync(gradleFile, 'utf8')));
            const props = path.join(android, 'gradle.properties');
            fs.writeFileSync(props, patchGradleProperties(fs.existsSync(props) ? fs.readFileSync(props, 'utf8') : ''));
        }
        else {
            detail('[dry run] android/app/build.gradle: release signed by the key in MK_SIGNING_* (environment only)');
            detail(`[dry run] android/gradle.properties: ${Object.entries(GRADLE_PROPERTIES).map(([k, v]) => `${k}=${v}`).join(', ')}`);
        }
        // --- Gradle --------------------------------------------------------------
        const wrapper = path.join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
        const gradlew = p.tool.gradlew.length > 0 ? p.tool.gradlew : [wrapper];
        info('Gradle assembleRelease (about 10–20 minutes; keep the PC otherwise idle)');
        const gradle = act(p.dryRun, gradlew, GRADLE_ARGS, {
            cwd: android,
            live: true,
            env: {
                ...buildEnv,
                GRADLE_OPTS: '-Xmx512m',
                [SIGNING_ENV.storeFile]: signing.storeFile,
                [SIGNING_ENV.storePassword]: signing.storePassword,
                [SIGNING_ENV.keyAlias]: signing.keyAlias,
                [SIGNING_ENV.keyPassword]: signing.keyPassword,
            },
        });
        if (gradle.status !== 0)
            fail('Gradle build failed (see above). Out of memory? Close other programs and retry.');
        if (!p.dryRun) {
            if (!fs.existsSync(out))
                fail(`Gradle built no ${path.relative(p.root, out)}`);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(out, dest);
            built = true;
        }
    }
    finally {
        putBack();
        // EAS would treat a leftover android/ as a bare project: never leave it.
        if (!p.dryRun)
            fs.rmSync(android, { recursive: true, force: true });
    }
    if (gitStatus(p.root) !== before) {
        fail('The build changed tracked files (git status differs from before): check `git status` and `git diff`.');
    }
    if (!built)
        return { apk: dest, built: false };
    info(`Built in ${Math.round((Date.now() - started) / 60000)} min: ${rel}`);
    if (options.verify ?? true) {
        try {
            verifyApk(dest, {
                androidPackage: p.config.androidPackage,
                version: p.app.version,
                versionCode: p.app.versionCode,
                versionCodeFrom: 'app.json',
                sha1: normalizeSha1(p.config.signingSha1) ?? '',
            }, p.tool.aapt, p.tool.apksigner);
        }
        catch (e) {
            fs.rmSync(dest, { force: true });
            throw e;
        }
    }
    return { apk: dest, built: true };
}
/** `mk build --local --profile <name> [--dry-run]`. */
export async function buildCommand(args) {
    let local = false;
    let profile = null;
    let dryRun = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--local')
            local = true;
        else if (a === '--dry-run')
            dryRun = true;
        else if (a === '--profile') {
            profile = args[++i] ?? null;
            if (!profile)
                fail(`--profile needs a name. ${LOCAL_BUILD_USAGE}`);
        }
        else
            fail(`Unknown option: ${a}. ${LOCAL_BUILD_USAGE}`);
    }
    if (!local)
        fail(`mk build only builds locally (--local); EAS builds run through qa:device and release:build. ${LOCAL_BUILD_USAGE}`);
    if (!profile)
        fail(`--profile is required. ${LOCAL_BUILD_USAGE}`);
    const p = openProject({ dryRun, requireDryRunInFixture: false });
    const r = localBuild(p, profile);
    if (r.built)
        info(`Ready: ${path.relative(p.root, r.apk).replace(/\\/g, '/')}`);
}
