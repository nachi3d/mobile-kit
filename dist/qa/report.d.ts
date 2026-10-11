import type { DeviceInfo } from '../android.js';
export interface FlowResult {
    flow: string;
    ok: boolean;
    seconds: number;
    /** Last lines of Maestro's output when it failed. */
    error?: string;
}
export interface Shot {
    screen: string;
    mode: string;
    lang: string;
    scale: number;
    /** Relative to the report; absent when the capture failed. */
    file?: string;
    error?: string;
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
    finishedAt: string;
    smoke: FlowResult[];
    shots: Shot[];
    notes: string[];
}
export declare const scaleLabel: (scale: number) => string;
/** The QA gallery: one self-contained page next to the PNGs. */
export declare function renderReport(r: QaRun): string;
