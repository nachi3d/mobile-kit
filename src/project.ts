import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_FILE, loadConfig, readAppJson, type AppJson, type KitConfig } from './config.js';
import { isInjected, toolCommand, TOOLS, toolEnv, type ToolName } from './exec.js';
import { fail, info } from './log.js';

export interface Project {
  root: string;
  config: KitConfig;
  app: AppJson;
  dryRun: boolean;
  tool: Record<ToolName, string[]>;
}

function findRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) fail(`No ${CONFIG_FILE} here or in a parent folder. Run mk from the app folder.`);
    dir = parent;
  }
}

/**
 * The app the command works on. MK_ROOT is a TEST FIXTURE used instead of
 * the app: it requires every external command injected (MK_*), and
 * `requireDryRunInFixture` (release commands) also requires --dry-run.
 */
export function openProject(options: { dryRun: boolean; requireDryRunInFixture: boolean }): Project {
  const fixture = process.env.MK_ROOT;
  let root: string;
  if (fixture) {
    if (options.requireDryRunInFixture && !options.dryRun) fail('MK_ROOT (test fixture) works only with --dry-run');
    for (const t of TOOLS) {
      if (!isInjected(t)) fail(`MK_ROOT is set: ${toolEnv(t)} must be injected too`);
    }
    root = path.resolve(fixture);
  } else {
    root = findRoot(process.cwd());
  }
  const config = loadConfig(root);
  const app = readAppJson(root);
  if (app.androidPackage !== config.androidPackage) {
    fail(`app.json android.package is ${app.androidPackage}, ${CONFIG_FILE} says ${config.androidPackage}`);
  }
  const tool = Object.fromEntries(TOOLS.map((t) => [t, toolCommand(t)])) as Record<ToolName, string[]>;
  if (options.dryRun) info('DRY RUN: nothing is built, uploaded, installed, purged or changed on the device');
  return { root, config, app, dryRun: options.dryRun, tool };
}

export interface EnvLocal {
  cfZoneId: string;
  cfPurgeToken: string;
}

/**
 * The known keys of <root>/.env.local. Values are never printed; EXPO_TOKEN
 * goes to the environment, where eas-cli reads it.
 */
export function loadEnvLocal(root: string): EnvLocal {
  const file = path.join(root, '.env.local');
  if (!fs.existsSync(file)) {
    fail('.env.local is missing: copy .env.local.example and fill it in (mobile-kit README → Setup)');
  }
  const out: EnvLocal = { cfZoneId: '', cfPurgeToken: '' };
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const key = line.slice(0, line.indexOf('=')).trim();
    const value = line
      .slice(line.indexOf('=') + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
    if (key === 'CF_ZONE_ID') out.cfZoneId = value;
    else if (key === 'CF_PURGE_TOKEN') out.cfPurgeToken = value;
    else if (key === 'EXPO_TOKEN' && value) process.env.EXPO_TOKEN = value;
  }
  return out;
}
