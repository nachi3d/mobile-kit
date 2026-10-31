// The JDK a local Android build needs: JAVA_HOME must be a JDK (it has
// bin/javac) of major version REQUIRED_JDK. On 2026-10-23 JAVA_HOME was a
// JRE 21 (no javac): Gradle failed after 24 minutes and mk blamed memory.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';
export const REQUIRED_JDK = 17;
function javacIn(home) {
    for (const name of ['javac.exe', 'javac']) {
        const file = path.join(home, 'bin', name);
        if (fs.existsSync(file))
            return file;
    }
    return null;
}
/** "17.0.18" → 17, "1.8.0_392" → 8. */
export function javaMajor(version) {
    const m = /^(\d+)(?:\.(\d+))?/.exec(version.trim());
    if (!m?.[1])
        return null;
    const first = Number(m[1]);
    return first === 1 && m[2] ? Number(m[2]) : first;
}
/** The JDK (or JRE) at `home`: its `release` file, else `javac -version`. */
export function readJdk(home) {
    const javac = javacIn(home);
    let version = null;
    const release = path.join(home, 'release');
    if (fs.existsSync(release)) {
        version = /^JAVA_VERSION="?([^"\r\n]+)"?/m.exec(fs.readFileSync(release, 'utf8'))?.[1] ?? null;
    }
    if (!version && javac) {
        const r = run([javac], ['-version']);
        version = /javac\s+(\S+)/.exec(`${r.stdout}\n${r.stderr}`)?.[1] ?? null;
    }
    return { home, javac, major: version ? javaMajor(version) : null, version };
}
/** JDKs of the required version installed in the usual places (for the setx hint). */
export function findJdkCandidates(env = process.env) {
    const parents = [
        ...['Microsoft', 'Eclipse Adoptium', 'Java', 'Zulu', 'Amazon Corretto', 'BellSoft'].flatMap((vendor) => [env.ProgramFiles, env.ProgramW6432].filter((d) => !!d).map((d) => path.join(d, vendor))),
        '/usr/lib/jvm',
        '/Library/Java/JavaVirtualMachines',
    ];
    const found = [];
    for (const parent of [...new Set(parents)]) {
        if (!fs.existsSync(parent))
            continue;
        for (const name of fs.readdirSync(parent).sort()) {
            for (const home of [path.join(parent, name), path.join(parent, name, 'Contents', 'Home')]) {
                if (!fs.existsSync(home) || found.includes(home))
                    continue;
                const jdk = readJdk(home);
                if (jdk.javac && jdk.major === REQUIRED_JDK)
                    found.push(home);
            }
        }
    }
    return found;
}
/** How to point JAVA_HOME at `home` for good (a new terminal picks it up). */
export function setJavaHomeHint(home, platform = process.platform) {
    if (!home) {
        return platform === 'win32'
            ? `Install one (winget install Microsoft.OpenJDK.${REQUIRED_JDK}), then: setx JAVA_HOME "<its folder>" and open a new terminal.`
            : `Install a JDK ${REQUIRED_JDK}, then: export JAVA_HOME=<its folder> (in your shell profile).`;
    }
    return platform === 'win32'
        ? `Run: setx JAVA_HOME "${home}"   then open a new terminal.`
        : `Run: export JAVA_HOME="${home}"   (and add it to your shell profile).`;
}
/**
 * Why JAVA_HOME cannot build Android (with the fix), or null when it is a
 * JDK REQUIRED_JDK.
 */
export function jdkProblem(env = process.env, platform = process.platform) {
    const home = env.JAVA_HOME;
    const fix = () => setJavaHomeHint(findJdkCandidates(env)[0], platform);
    if (!home)
        return `JAVA_HOME is not set: Gradle needs a JDK ${REQUIRED_JDK}. ${fix()}`;
    if (!fs.existsSync(home))
        return `JAVA_HOME is ${home}, which does not exist. ${fix()}`;
    const jdk = readJdk(home);
    const what = jdk.version ? ` (Java ${jdk.version})` : '';
    if (!jdk.javac) {
        return `JAVA_HOME is ${home}${what}: a JRE, it has no bin${path.sep}javac, and Gradle cannot compile without it. ${fix()}`;
    }
    if (jdk.major !== REQUIRED_JDK) {
        const is = jdk.major === null ? 'a JDK whose version mk cannot read' : `JDK ${jdk.major}`;
        return `JAVA_HOME is ${home}: ${is}${what}; the Android build needs JDK ${REQUIRED_JDK}. ${fix()}`;
    }
    return null;
}
