export interface GuardState {
    mkPid: number;
    /** mk's start time (ms): tells mk's children from processes that got a reused pid. */
    mkStarted: number;
    /** The device under test, once known. */
    serial: string | null;
    avd: string | null;
    /** mk started the emulator: the clean-up stops it. */
    ownsEmulator: boolean;
    /** --keep-emulator: the clean-up leaves the emulator running. */
    keepEmulator: boolean;
    /** The adb command line (MK_ADB or the default). */
    adb: string[];
    /** Written when mk's parent died: mk stops at its next checkpoint. */
    orphanFlag: string;
}
export type GuardAction = 'exit' | 'cleanup' | 'orphaned' | 'kill' | 'wait';
/** What the guard does this poll. */
export declare function guardStep(s: {
    stateFile: boolean;
    mkAlive: boolean;
    ancestorsAlive: boolean;
    orphanedFor: number | null;
    graceMs: number;
}): GuardAction;
/** After mk died: everything it left. Returns a summary for the log. */
export declare function cleanUp(s: GuardState): string;
/** The guard's loop (procs.js guard-loop <stateFile>). */
export declare function guardLoop(stateFile: string): Promise<void>;
