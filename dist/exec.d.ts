export declare const TOOLS: readonly ["eas", "wrangler", "curl", "adb", "maestro", "aapt", "apksigner", "open", "emulator", "avdmanager", "procs", "expo", "gradlew", "keytool"];
export type ToolName = (typeof TOOLS)[number];
export declare const toolEnv: (tool: ToolName) => string;
/** Android SDK folders that exist, in lookup order. */
export declare function sdkRoots(env?: NodeJS.ProcessEnv): string[];
/** Newest build-tools binary of the Android SDK, or null. */
export declare function findBuildTool(name: string, env?: NodeJS.ProcessEnv): string | null;
/** `name` in a folder of PATH, or null. */
export declare function findOnPath(name: string, env?: NodeJS.ProcessEnv): string | null;
/** keytool, looked for in order: PATH, JAVA_HOME, Android Studio's bundled JDK (JBR); or null. */
export declare function findKeytool(env?: NodeJS.ProcessEnv): string | null;
/** A binary at a fixed place in the SDK (emulator, cmdline-tools), or null. */
export declare function findSdkTool(...parts: string[]): string | null;
export declare function parseCommand(value: string): string[];
/** The command line of a tool: injected (MK_*) or the default. */
export declare function toolCommand(tool: ToolName, env?: NodeJS.ProcessEnv): string[];
export declare const isInjected: (tool: ToolName, env?: NodeJS.ProcessEnv) => boolean;
export interface RunOptions {
    cwd?: string;
    input?: string;
    /** stdout as raw bytes (adb screencap). */
    binary?: boolean;
    /** Show the command's stderr live (long EAS builds). */
    liveStderr?: boolean;
    /** Show stdout and stderr live, nothing captured (Gradle). */
    live?: boolean;
    /** Fully interactive: the user answers the command's prompts (eas credentials). */
    interactive?: boolean;
    env?: NodeJS.ProcessEnv;
}
export interface RunResult {
    status: number;
    stdout: string;
    stdoutBytes: Buffer;
    stderr: string;
}
export declare function run(argv: string[], args: string[], options?: RunOptions): RunResult;
export declare const formatCommand: (argv: string[]) => string;
/**
 * A command with side effects (build, upload, install, device setting).
 * In a dry run it is only printed.
 */
export declare function act(dryRun: boolean, argv: string[], args: string[], options?: RunOptions): RunResult;
