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
