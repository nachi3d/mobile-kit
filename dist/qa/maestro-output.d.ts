export interface MaestroOutput {
    /** The output without the box and the debug banner. */
    text: string;
    /** The folder Maestro printed under "==== Debug output", or null. */
    debugDir: string | null;
    /** e.g. "Tap on id: tab-shelves: Element not found: Id matching regex: tab-shelves" */
    errorLine: string | null;
}
export declare function parseMaestroOutput(output: string): MaestroOutput;
