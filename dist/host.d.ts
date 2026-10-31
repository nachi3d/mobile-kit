import type { GuardState } from './guard.js';
import type { Project } from './project.js';
export interface HostMemory {
    freeMb: number;
    emulatorMb: number;
}
/** Free RAM and the emulator's memory, or null when it cannot be read. */
export declare function hostMemory(p: Project): HostMemory | null;
/** Why the emulator should be restarted, or null. */
export declare function memoryPressure(m: HostMemory, limits: {
    minFreeMb: number;
    maxEmulatorMb: number;
}): string | null;
/** Maestro runs on `serial` still alive (a run that was killed): how many were stopped. */
export declare function killLeftoverMaestro(p: Project, serial: string): number;
/** The AVD's emulator processes, when `adb emu kill` did not stop them. */
export declare function killEmulatorProcesses(p: Project, avd: string): number;
/** Every process mk started (Maestro, adb, the emulator), at once: a forced stop. */
export declare function killChildren(p: Project): number;
export interface Guard {
    /** The device changed (a restart) or mk now owns the emulator. */
    update(patch: Partial<Pick<GuardState, 'serial' | 'ownsEmulator'>>): void;
    /** The process that started mk is gone (the guard wrote the flag): stop now. */
    orphaned(): boolean;
    /** mk is done: the guard exits without touching anything. */
    stop(): void;
}
/** Starts the guard (guard.ts) for this run; none on a dry run. */
export declare function startGuard(p: Project, initial: Pick<GuardState, 'serial' | 'ownsEmulator' | 'keepEmulator'>): Guard;
