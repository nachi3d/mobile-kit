// Process trees of the host: who descends from mk, who mk descends from.
// Pure functions over a process list, plus the OS listing (procs.js and
// guard.ts only: mk itself reaches them through MK_PROCS, so tests fake it).
import { spawnSync } from 'node:child_process';
/**
 * Windows keeps a dead parent's pid in ParentProcessId, and pids are
 * reused: a "child" that started before its parent is someone else's.
 */
const childOf = (child, parent) => child.ppid === parent.pid && child.pid !== parent.pid && (!parent.created || !child.created || child.created >= parent.created - 1000);
/** Every process below `root` (children before their own children), alive parent or not. */
export function descendants(procs, root) {
    const out = [];
    const queue = [root];
    while (queue.length) {
        const parent = queue.shift();
        for (const p of procs) {
            if (childOf(p, parent) && !out.some((o) => o.pid === p.pid)) {
                out.push(p);
                queue.push(p);
            }
        }
    }
    return out;
}
/** `pid`'s parent, grandparent… up to the system (pids 0, 1 and 4 excluded). */
export function ancestors(procs, pid) {
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const out = [];
    let current = byPid.get(pid);
    while (current) {
        const parent = byPid.get(current.ppid);
        if (!parent || parent.pid <= 4 || out.includes(parent) || !childOf(current, parent))
            break;
        out.push(parent);
        current = parent;
    }
    return out;
}
/** The emulator itself: killing it to unblock mk would also kill the device mk restores. */
export const isEmulatorProcess = (p) => /^(emulator|qemu-system)/i.test(p.name);
function powershell(script) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    return r.stdout ?? '';
}
/** "[[dd-]hh:]mm:ss" (ps etime) → seconds. */
export function etimeSeconds(etime) {
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
    if (!m)
        return 0;
    return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}
/** Every process of the host. */
export function listProcesses() {
    if (process.platform === 'win32') {
        const json = powershell("Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, " +
            "@{n='Created';e={if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }}} | ConvertTo-Json -Compress");
        try {
            const rows = JSON.parse(json || '[]');
            return (Array.isArray(rows) ? rows : [rows]).map((r) => ({
                pid: r.ProcessId,
                ppid: r.ParentProcessId,
                name: r.Name ?? '',
                created: r.Created ? Date.parse(r.Created) || 0 : 0,
            }));
        }
        catch {
            return [];
        }
    }
    const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,etime=,comm='], { encoding: 'utf8' });
    const now = Date.now();
    const out = [];
    for (const line of (r.stdout ?? '').split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (m)
            out.push({ pid: Number(m[1]), ppid: Number(m[2]), created: now - etimeSeconds(m[3]) * 1000, name: (m[4] ?? '').split('/').pop() ?? '' });
    }
    return out;
}
export function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        // EPERM: it exists, but belongs to someone else.
        return e.code === 'EPERM';
    }
}
/** Kills `procs` (deepest first, so no parent respawns a child); returns how many. */
export function killAll(procs) {
    let n = 0;
    for (const p of [...procs].reverse()) {
        try {
            process.kill(p.pid, 'SIGKILL');
            n++;
        }
        catch {
            // Already gone.
        }
    }
    return n;
}
