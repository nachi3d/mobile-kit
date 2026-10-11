import type { ScreenConfig } from '../config.js';
export type Mode = 'light' | 'dark';
export interface Setting {
    mode: Mode;
    lang: string;
    scale: number;
}
export interface Batch extends Setting {
    screens: string[];
}
export interface Plan {
    batches: Batch[];
    total: number;
    summary: string;
}
export declare const settingLabel: (s: Setting) => string;
export declare const shotName: (screen: string, s: Setting) => string;
export declare const shotKey: (screen: string, s: {
    mode: string;
    lang: string;
    scale: number;
}) => string;
export declare function buildPlan(screens: ScreenConfig[], modes: Mode[], languages: string[], fontScales: number[]): Plan;
