import { type AppJson, type KitConfig } from './config.js';
import { type ToolName } from './exec.js';
export interface Project {
    root: string;
    config: KitConfig;
    app: AppJson;
    dryRun: boolean;
    tool: Record<ToolName, string[]>;
}
/**
 * The app the command works on. MK_ROOT is a TEST FIXTURE used instead of
 * the app: it requires every external command injected (MK_*), and
 * `requireDryRunInFixture` (release commands) also requires --dry-run.
 */
export declare function openProject(options: {
    dryRun: boolean;
    requireDryRunInFixture: boolean;
}): Project;
export interface EnvLocal {
    cfZoneId: string;
    cfPurgeToken: string;
}
/**
 * The known keys of <root>/.env.local. Values are never printed; EXPO_TOKEN
 * goes to the environment, where eas-cli reads it.
 */
export declare function loadEnvLocal(root: string): EnvLocal;
