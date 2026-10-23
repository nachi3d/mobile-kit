// External commands. Every one comes from the environment first, so tests
// inject fakes without touching PATH:
//
//   MK_EAS        default "npx eas-cli"
//   MK_WRANGLER   default "npx wrangler"
//   MK_CURL       default "curl"
//   MK_ADB        default "adb"
//   MK_MAESTRO    default "maestro"
//   MK_AAPT       default aapt2 of the newest Android SDK build-tools
//   MK_APKSIGNER  default apksigner of the newest Android SDK build-tools
//   MK_OPEN       default the OS "open this file" command
//   MK_EMULATOR   default emulator of the Android SDK
//   MK_AVDMANAGER default avdmanager of the SDK's cmdline-tools/latest
//   MK_PROCS      default `node dist/procs.js` (host memory, leftover processes)
//   MK_EXPO       default "npx expo" (local builds: expo prebuild)
//   MK_GRADLEW    default the app's android/gradlew (local builds)
//   MK_KEYTOOL    default keytool on PATH, else of JAVA_HOME, else of Android Studio's JBR
//
// A value is split on whitespace, or is a JSON array of strings when it
// starts with "[" (for paths with spaces). An empty value means "missing"
// (aapt2 / apksigner only).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detail } from './log.js';
export const TOOLS = [
    'eas', 'wrangler', 'curl', 'adb', 'maestro', 'aapt', 'apksigner', 'open', 'emulator', 'avdmanager', 'procs',
    'expo', 'gradlew', 'keytool',
];
export const toolEnv = (tool) => `MK_${tool.toUpperCase()}`;
/** Android SDK folders that exist, in lookup order. */
export function sdkRoots(env = process.env) {
    const home = env.HOME ?? env.USERPROFILE ?? '';
    const candidates = [
        env.ANDROID_HOME,
        env.ANDROID_SDK_ROOT,
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Android', 'Sdk'),
        home && path.join(home, 'Android', 'Sdk'),
        home && path.join(home, 'Library', 'Android', 'sdk'),
    ];
    return [...new Set(candidates.filter((c) => !!c && fs.existsSync(c)))];
}
function existing(file) {
    for (const ext of ['', '.exe', '.bat'])
        if (fs.existsSync(file + ext))
            return file + ext;
    return null;
}
/** Newest build-tools binary of the Android SDK, or null. */
export function findBuildTool(name, env = process.env) {
    for (const sdk of sdkRoots(env)) {
        const dir = path.join(sdk, 'build-tools');
        if (!fs.existsSync(dir))
            continue;
        const versions = fs
            .readdirSync(dir)
            .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
            .reverse();
        for (const version of versions) {
            const file = existing(path.join(dir, version, name));
            if (file)
                return file;
        }
    }
    return null;
}
/** `name` in a folder of PATH, or null. */
export function findOnPath(name, env = process.env) {
    for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
        const file = dir ? existing(path.join(dir, name)) : null;
        if (file)
            return file;
    }
    return null;
}
/** keytool, looked for in order: PATH, JAVA_HOME, Android Studio's bundled JDK (JBR); or null. */
export function findKeytool(env = process.env) {
    const onPath = findOnPath('keytool', env);
    if (onPath)
        return onPath;
    const dirs = [
        env.JAVA_HOME && path.join(env.JAVA_HOME, 'bin'),
        env.ProgramFiles && path.join(env.ProgramFiles, 'Android', 'Android Studio', 'jbr', 'bin'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Android Studio', 'jbr', 'bin'),
        '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin',
        '/opt/android-studio/jbr/bin',
    ];
    for (const dir of dirs) {
        const file = dir ? existing(path.join(dir, 'keytool')) : null;
        if (file)
            return file;
    }
    return null;
}
/** A binary at a fixed place in the SDK (emulator, cmdline-tools), or null. */
export function findSdkTool(...parts) {
    for (const sdk of sdkRoots()) {
        const file = existing(path.join(sdk, ...parts));
        if (file)
            return file;
    }
    return null;
}
function defaultCommand(tool) {
    switch (tool) {
        case 'eas':
            return ['npx', 'eas-cli'];
        case 'wrangler':
            return ['npx', 'wrangler'];
        case 'aapt': {
            const f = findBuildTool('aapt2');
            return f ? [f] : [];
        }
        case 'apksigner': {
            const f = findBuildTool('apksigner');
            return f ? [f] : [];
        }
        case 'emulator': {
            const f = findSdkTool('emulator', 'emulator');
            return f ? [f] : ['emulator'];
        }
        case 'avdmanager': {
            const f = findSdkTool('cmdline-tools', 'latest', 'bin', 'avdmanager');
            return f ? [f] : ['avdmanager'];
        }
        case 'expo':
            return ['npx', 'expo'];
        // The generated android/ folder's wrapper: build/local.ts finds it once prebuild made it.
        case 'gradlew':
            return [];
        // Empty when there is none: keystore.ts says where it looked.
        case 'keytool': {
            const f = findKeytool();
            return f ? [f] : [];
        }
        case 'procs':
            return [process.execPath, fileURLToPath(new URL('./procs.js', import.meta.url))];
        case 'open':
            if (process.platform === 'win32')
                return ['explorer.exe'];
            return [process.platform === 'darwin' ? 'open' : 'xdg-open'];
        default:
            return [tool];
    }
}
export function parseCommand(value) {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === 'string')) {
            throw new Error(`Not a JSON array of strings: ${value}`);
        }
        return parsed;
    }
    return trimmed === '' ? [] : trimmed.split(/\s+/);
}
/** The command line of a tool: injected (MK_*) or the default. */
export function toolCommand(tool, env = process.env) {
    const injected = env[toolEnv(tool)];
    return injected !== undefined ? parseCommand(injected) : defaultCommand(tool);
}
export const isInjected = (tool, env = process.env) => env[toolEnv(tool)] !== undefined;
/**
 * Windows runs .cmd / .bat files (npx, maestro, apksigner) only through
 * cmd.exe: those get a quoted command string, everything else is spawned
 * directly.
 */
function windowsScript(cmd) {
    if (/\.(cmd|bat)$/i.test(cmd))
        return true;
    if (/[\\/]/.test(cmd) || path.extname(cmd))
        return false;
    const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase());
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        for (const ext of exts) {
            if (dir && fs.existsSync(path.join(dir, cmd + ext)))
                return ext === '.cmd' || ext === '.bat';
        }
    }
    return false;
}
const cmdQuote = (arg) => (/^[\w./:=@+,\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`);
export function run(argv, args, options = {}) {
    const [cmd, ...pre] = argv;
    if (!cmd)
        throw new Error('Empty command');
    const all = [...pre, ...args];
    const shell = process.platform === 'win32' && windowsScript(cmd);
    const result = spawnSync(shell ? [cmd, ...all].map(cmdQuote).join(' ') : cmd, shell ? [] : all, {
        cwd: options.cwd,
        input: options.input,
        env: options.env ?? process.env,
        shell,
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
        stdio: options.interactive
            ? 'inherit'
            : ['pipe', options.live ? 'inherit' : 'pipe', options.live || options.liveStderr ? 'inherit' : 'pipe'],
    });
    const stdoutBytes = result.stdout ?? Buffer.alloc(0);
    return {
        status: result.error ? 127 : (result.status ?? 1),
        stdout: options.binary ? '' : stdoutBytes.toString('utf8').replace(/\r/g, ''),
        stdoutBytes,
        stderr: (result.stderr?.toString('utf8') ?? String(result.error ?? '')).replace(/\r/g, ''),
    };
}
const shellQuote = (arg) => (/^[\w./:=@+,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
export const formatCommand = (argv) => argv.map(shellQuote).join(' ');
/**
 * A command with side effects (build, upload, install, device setting).
 * In a dry run it is only printed.
 */
export function act(dryRun, argv, args, options = {}) {
    if (dryRun) {
        detail(`[dry run, not executed] ${formatCommand([...argv, ...args])}`);
        return { status: 0, stdout: '', stdoutBytes: Buffer.alloc(0), stderr: '' };
    }
    return run(argv, args, options);
}
