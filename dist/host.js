// The computer running mk: memory, and processes a killed run left behind.
import { act, run } from './exec.js';
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
