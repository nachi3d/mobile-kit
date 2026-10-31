// The guard: a detached process that watches a qa:device run, so a killed
// run leaves nothing behind. On 2026-10-23 Claude Code killed only the
// shell that started mk: mk, Maestro and the emulator kept running.
//
// mk writes a state file (its pid, the device, whether it started the
// emulator) and starts `procs.js guard <file>`, which launches the guard
// detached and returns at once: the guard is nobody's child, so killing
// mk's process tree does not kill it. Every MK_GUARD_POLL_MS (2 s):
//   - the state file is gone: mk finished normally, the guard exits;
//   - mk is dead (killed): its leftovers are cleaned up (below);
//   - a process mk descends from is dead (the terminal or the shell that
//     started it): the orphan flag file is written, mk's children are
//     killed so its current step returns, and mk stops on its next
//     checkpoint, restores the device and exits; if it is still alive
//     MK_GUARD_GRACE_MS (90 s) later, it is killed and cleaned up after.
// Clean-up: every process mk started (Maestro, adb sessions, the emulator),
// Maestro and adb processes still talking to the device, and the
// emulator's processes when mk started it (`adb emu kill` first).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { ancestors, descendants, isAlive, isEmulatorProcess, killAll, listProcesses } from './proctree.js';
/** What the guard does this poll. */
export function guardStep(s) {
    if (!s.stateFile)
        return 'exit';
    if (!s.mkAlive)
        return 'cleanup';
    if (s.orphanedFor === null)
        return s.ancestorsAlive ? 'wait' : 'orphaned';
    return s.orphanedFor > s.graceMs ? 'kill' : 'wait';
}
const pollMs = () => Number(process.env.MK_GUARD_POLL_MS) || 2000;
const graceMs = () => Number(process.env.MK_GUARD_GRACE_MS) || 90_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function readState(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
}
/** Processes whose command line names the device: Maestro and adb sessions on it. */
function onDevice(procs, serial) {
    return procs.filter((p) => p.cmd && p.pid !== process.pid && p.cmd.includes(serial) && /maestro|adb/i.test(p.cmd));
}
/** Command lines too (Windows: CIM; elsewhere: ps args). */
function listWithCommands() {
    if (process.platform === 'win32') {
        const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true });
        let rows = [];
        try {
            const parsed = JSON.parse(r.stdout || '[]');
            rows = Array.isArray(parsed) ? parsed : [parsed];
        }
        catch {
            rows = [];
        }
        const cmds = new Map(rows.map((x) => [x.ProcessId, x.CommandLine ?? '']));
        return listProcesses().map((p) => ({ ...p, cmd: cmds.get(p.pid) ?? '' }));
    }
    const r = spawnSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' });
    const cmds = new Map((r.stdout ?? '').split('\n').flatMap((l) => {
        const m = /^\s*(\d+)\s+(.*)$/.exec(l);
        return m ? [[Number(m[1]), m[2] ?? '']] : [];
    }));
    return listProcesses().map((p) => ({ ...p, cmd: cmds.get(p.pid) ?? '' }));
}
/** After mk died: everything it left. Returns a summary for the log. */
export function cleanUp(s) {
    const all = listWithCommands();
    const mk = { pid: s.mkPid, created: s.mkStarted };
    const killed = [];
    const stopEmulator = s.ownsEmulator && !s.keepEmulator;
    if (s.serial && stopEmulator) {
        const [cmd, ...pre] = s.adb;
        if (cmd)
            spawnSync(cmd, [...pre, '-s', s.serial, 'emu', 'kill'], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
    }
    // An emulator below mk is one mk started (even mid-boot, before ownsEmulator was set).
    const children = descendants(all, mk).filter((p) => !s.keepEmulator || !isEmulatorProcess(p));
    killed.push(...children);
    if (s.serial)
        killed.push(...onDevice(all, s.serial).filter((p) => !killed.some((k) => k.pid === p.pid)));
    if (stopEmulator && s.avd) {
        const avd = s.avd;
        killed.push(...all.filter((p) => p.cmd.includes(`-avd ${avd}`) && !killed.some((k) => k.pid === p.pid)));
    }
    return `killed ${killAll(killed)} process(es)`;
}
/** MK_GUARD_LOG: a file where the guard says what it does (nothing by default: it runs detached). */
function log(message) {
    const file = process.env.MK_GUARD_LOG;
    if (file)
        fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
}
/** The guard's loop (procs.js guard-loop <stateFile>). */
export async function guardLoop(stateFile) {
    const first = readState(stateFile);
    if (!first)
        return;
    const procs = listProcesses();
    const watched = ancestors(procs, first.mkPid).map((p) => p.pid).filter((pid) => pid !== process.pid);
    log(`watching mk ${first.mkPid}, started by ${watched.join(' < ') || 'nothing found'}`);
    let orphanedAt = null;
    for (;;) {
        const s = readState(stateFile);
        const action = guardStep({
            stateFile: s !== null,
            mkAlive: isAlive(first.mkPid),
            ancestorsAlive: watched.every(isAlive),
            orphanedFor: orphanedAt === null ? null : Date.now() - orphanedAt,
            graceMs: graceMs(),
        });
        if (action !== 'wait')
            log(action);
        if (action === 'exit' || !s)
            return;
        if (action === 'cleanup' || action === 'kill') {
            if (action === 'kill')
                killAll([{ pid: s.mkPid, ppid: 0, name: 'mk', created: s.mkStarted }]);
            log(cleanUp(s));
            fs.rmSync(stateFile, { force: true });
            return;
        }
        if (action === 'orphaned') {
            orphanedAt = Date.now();
            fs.writeFileSync(s.orphanFlag, `${new Date().toISOString()} the process that started mk is gone\n`);
            // mk is blocked in its current step (a Maestro flow can take minutes):
            // its children go, the step returns, mk sees the flag and stops.
            const n = killAll(descendants(listProcesses(), { pid: s.mkPid, created: s.mkStarted }).filter((p) => !isEmulatorProcess(p)));
            log(`killed ${n} child process(es) of mk`);
        }
        await sleep(pollMs());
    }
}
