import { type AnrDialog } from './android.js';
import { type EmulatorConfig, type GpuMode } from './config.js';
import type { Project } from './project.js';
export declare const EMULATOR_USAGE = "Usage: mk emulator [--wipe] [--dry-run]";
/** Local emulators are "emulator-<port>" on adb; anything else is hardware (USB or Wi-Fi). */
export declare const isEmulatorSerial: (serial: string) => boolean;
export declare function avdHome(env?: NodeJS.ProcessEnv): string;
/** config.ini lines for the keys mk manages; everything else is kept. */
export declare function tuneConfigIni(text: string, e: EmulatorConfig): string;
export interface EmulatorStart {
    wipe?: boolean;
    /** Stop it if it is running, then boot without the quick-boot snapshot. */
    cold?: boolean;
}
export interface EmulatorReady {
    serial: string;
    /** This call started it (it was not already running). */
    started: boolean;
    /** SurfaceFlinger's GLES renderer, or null when it cannot be read (dry run). */
    renderer: string | null;
    /**
     * The emulator renders in software (SwiftShader) although the config asks
     * for a GPU mode (host…): it will use far more host memory. Null when unknown.
     */
    softwareRendering: string | null;
    /** An ANR dialog dismissed (or not) after the boot. */
    anr: AnrDialog | null;
}
/** Why the rendering is a problem: software although `requested` is a GPU mode; null when fine. */
export declare function softwareRenderingWarning(requested: GpuMode, renderer: string | null): string | null;
/** Emulator command-line arguments. */
export declare function emulatorArgs(e: EmulatorConfig, gpu: GpuMode, o: EmulatorStart): string[];
/** Stops the AVD's emulator: `adb emu kill`, then its processes if it does not go away. */
export declare function stopEmulator(p: Project, serial: string): Promise<void>;
/** Starts (or reuses) the emulator and returns its serial once it is ready. */
export declare function ensureEmulator(p: Project, o?: EmulatorStart): Promise<EmulatorReady>;
export declare function parseEmulatorArgs(args: string[]): {
    wipe: boolean;
    dryRun: boolean;
};
