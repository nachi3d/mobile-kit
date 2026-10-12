import type { DeviceInfo } from '../android.js';
export interface FlowResult {
    flow: string;
    ok: boolean;
    seconds: number;
    /** Last lines of Maestro's output when it failed (its Cloud box removed). */
    error?: string;
    /** The step that failed and why, e.g. "Tap on id: x: Element not found: …". */
    errorLine?: string;
    /** Copy of Maestro's debug folder, relative to the report. */
    debug?: string;
}
export interface Shot {
    screen: string;
    mode: string;
    lang: string;
    scale: number;
    /** Relative to the report; absent when the capture failed or did not run yet. */
    file?: string;
    error?: string;
    /** Copy of Maestro's debug folder of the failed flow, relative to the report. */
    debug?: string;
}
/** Device settings read before the matrix and put back after it. */
export interface SavedSettings {
    night: string;
    fontScale: string;
    appLocales: string | null;
}
export interface QaRun {
    appName: string;
    androidPackage: string;
    version: string;
    versionCode: number;
    installedVersionCode: number | null;
    apk: string;
    device: DeviceInfo;
    startedAt: string;
    /** Empty while the run is going on, or when it was killed. */
    finishedAt: string;
    /** The capture folder (absolute), for `--resume`. */
    outDir: string;
    /** e.g. "3 key screens × 2 modes × … = 32, in 8 batches" */
    plan: string;
    /** The device settings before the first run, restored at the end (kept by --resume). */
    saved: SavedSettings | null;
    smoke: FlowResult[];
    /** Every planned screenshot; those not run yet have neither file nor error. */
    shots: Shot[];
    notes: string[];
}
export declare const scaleLabel: (scale: number) => string;
/** The QA gallery: one self-contained page next to the PNGs. */
export declare function renderReport(r: QaRun): string;
