// The computer running mk: memory, and processes a killed run left behind.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { act, run } from './exec.js';
import { warn } from './log.js';
/** Free RAM and the emulator's memory, or null when it cannot be read. */
export function hostMemory(p) {
    const r = run(p.tool.procs, ['mem']);
    if (r.status !== 0)
        return null;
    try {
        const m = JSON.parse(r.stdout.trim());
        return typeof m.freeMb === 'number' && typeof m.emulatorMb === 'number' ? { freeMb: m.freeMb, emulatorMb: m.emulatorMb } : null;
    }
    catch {
        return null;
    }
}
/** Why the emulator should be restarted, or null. */
export function memoryPressure(m, limits) {
    if (m.freeMb < limits.minFreeMb)
        return `free RAM ${m.freeMb} MB < ${limits.minFreeMb} MB`;
    if (m.emulatorMb > limits.maxEmulatorMb)
        return `emulator uses ${m.emulatorMb} MB > ${limits.maxEmulatorMb} MB`;
    return null;
}
/** Maestro runs on `serial` still alive (a run that was killed): how many were stopped. */
export function killLeftoverMaestro(p, serial) {
    return Number(act(p.dryRun, p.tool.procs, ['kill-maestro', serial]).stdout.trim()) || 0;
}
/** The AVD's emulator processes, when `adb emu kill` did not stop them. */
export function killEmulatorProcesses(p, avd) {
    return Number(act(p.dryRun, p.tool.procs, ['kill-emulator', avd]).stdout.trim()) || 0;
}
/** Every process mk started (Maestro, adb, the emulator), at once: a forced stop. */
export function killChildren(p) {
    return Number(act(p.dryRun, p.tool.procs, ['kill-tree', String(process.pid)]).stdout.trim()) || 0;
}
const NO_GUARD = { update: () => undefined, orphaned: () => false, stop: () => undefined };
/** Starts the guard (guard.ts) for this run; none on a dry run. */
export function startGuard(p, initial) {
    if (p.dryRun)
        return NO_GUARD;
    const dir = process.env.MK_GUARD_DIR ?? os.tmpdir();
    const file = path.join(dir, `mk-guard-${process.pid}.json`);
    const state = {
        mkPid: process.pid,
        mkStarted: Date.now() - Math.round(process.uptime() * 1000),
        avd: p.config.emulator.avd,
        adb: p.tool.adb,
        orphanFlag: path.join(dir, `mk-guard-${process.pid}.orphaned`),
        ...initial,
    };
    const write = () => fs.writeFileSync(file, JSON.stringify(state));
    try {
        fs.rmSync(state.orphanFlag, { force: true });
        write();
    }
    catch (e) {
        warn(`No guard for this run (cannot write ${file}: ${e.message}): if mk is killed, stop Maestro and the emulator by hand`);
        return NO_GUARD;
    }
    if (run(p.tool.procs, ['guard', file]).status !== 0) {
        fs.rmSync(file, { force: true });
        warn('No guard for this run (procs.js guard failed): if mk is killed, stop Maestro and the emulator by hand');
        return NO_GUARD;
    }
    return {
        update(patch) {
            Object.assign(state, patch);
            if (fs.existsSync(file))
                write();
        },
        orphaned: () => fs.existsSync(state.orphanFlag),
        stop() {
            fs.rmSync(file, { force: true });
            fs.rmSync(state.orphanFlag, { force: true });
        },
    };
}
