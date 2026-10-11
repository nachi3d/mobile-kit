import type { EmulatorConfig } from './config.js';
import type { Project } from './project.js';
export declare const EMULATOR_USAGE = "Usage: mk emulator [--wipe] [--dry-run]";
/** Local emulators are "emulator-<port>" on adb; anything else is hardware (USB or Wi-Fi). */
export declare const isEmulatorSerial: (serial: string) => boolean;
export declare function avdHome(env?: NodeJS.ProcessEnv): string;
/** config.ini lines for the keys mk manages; everything else is kept. */
export declare function tuneConfigIni(text: string, e: EmulatorConfig): string;
/** Starts (or reuses) the emulator and returns its serial once it is ready. */
export declare function ensureEmulator(p: Project, options: {
    wipe: boolean;
}): Promise<string>;
export declare function parseEmulatorArgs(args: string[]): {
    wipe: boolean;
    dryRun: boolean;
};
