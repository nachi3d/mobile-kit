export interface Proc {
    pid: number;
    ppid: number;
    name: string;
    /** Start time, ms since the epoch (0 when unknown). */
    created: number;
}
/** Every process below `root` (children before their own children), alive parent or not. */
export declare function descendants(procs: Proc[], root: {
    pid: number;
    created: number;
}): Proc[];
/** `pid`'s parent, grandparent… up to the system (pids 0, 1 and 4 excluded). */
export declare function ancestors(procs: Proc[], pid: number): Proc[];
/** The emulator itself: killing it to unblock mk would also kill the device mk restores. */
export declare const isEmulatorProcess: (p: Proc) => boolean;
/** "[[dd-]hh:]mm:ss" (ps etime) → seconds. */
export declare function etimeSeconds(etime: string): number;
/** Every process of the host. */
export declare function listProcesses(): Proc[];
export declare function isAlive(pid: number): boolean;
/** Kills `procs` (deepest first, so no parent respawns a child); returns how many. */
export declare function killAll(procs: Proc[]): number;
