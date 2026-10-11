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
//
// A value is split on whitespace, or is a JSON array of strings when it
// starts with "[" (for paths with spaces). An empty value means "missing"
// (aapt2 / apksigner only).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { detail } from './log.js';
export const TOOLS = ['eas', 'wrangler', 'curl', 'adb', 'maestro', 'aapt', 'apksigner', 'open'];
export const toolEnv = (tool) => `MK_${tool.toUpperCase()}`;
/** Newest build-tools binary of the Android SDK, or null. */
export function findBuildTool(name, env = process.env) {
    const home = env.HOME ?? env.USERPROFILE ?? '';
    const sdks = [
        env.ANDROID_HOME,
        env.ANDROID_SDK_ROOT,
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Android', 'Sdk'),
        home && path.join(home, 'Android', 'Sdk'),
        home && path.join(home, 'Library', 'Android', 'sdk'),
    ];
    for (const sdk of sdks) {
        if (!sdk)
            continue;
        const dir = path.join(sdk, 'build-tools');
        if (!fs.existsSync(dir))
            continue;
        const versions = fs
            .readdirSync(dir)
            .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
            .reverse();
        for (const version of versions) {
            for (const ext of ['', '.exe', '.bat']) {
                const file = path.join(dir, version, name + ext);
                if (fs.existsSync(file))
                    return file;
            }
        }
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
        stdio: ['pipe', 'pipe', options.liveStderr ? 'inherit' : 'pipe'],
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
