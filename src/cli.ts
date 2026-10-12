#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { EMULATOR_USAGE, ensureEmulator, parseEmulatorArgs } from './emulator.js';
import { KitError } from './log.js';
import { openProject } from './project.js';
import { qaDevice, QA_USAGE } from './qa/device.js';
import { BUILD_USAGE, releaseBuild } from './release/build.js';
import { PROMOTE_USAGE, releasePromote } from './release/promote.js';

const version = (JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
  version: string;
}).version;

const HELP = `mobile-kit ${version}: device QA and APK releases for Expo apps.

  ${QA_USAGE}
  ${EMULATOR_USAGE}
  ${BUILD_USAGE}
  ${PROMOTE_USAGE}

Run from the app folder (it has mobile-kit.config.json). See the README.`;

/** --dry-run plus positionals; anything else starting with "-" is refused. */
function releaseArgs(args: string[], usage: string): { positional: string[]; dryRun: boolean } {
  const positional: string[] = [];
  let dryRun = false;
  for (const a of args) {
    if (a === '--dry-run') dryRun = true;
    else if (a.startsWith('-')) throw new KitError(`Unknown option: ${a}. ${usage}`);
    else positional.push(a);
  }
  return { positional, dryRun };
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    console.log(HELP);
    return;
  }
  if (command === '--version' || command === '-v') {
    console.log(version);
    return;
  }
  if (rest.includes('-h') || rest.includes('--help')) {
    console.log(HELP);
    return;
  }
  switch (command) {
    case 'qa:device':
      return qaDevice(rest);
    case 'emulator': {
      const o = parseEmulatorArgs(rest);
      const p = openProject({ dryRun: o.dryRun, requireDryRunInFixture: false });
      const { serial } = await ensureEmulator(p, { wipe: o.wipe });
      console.log(serial);
      return;
    }
    case 'release:build': {
      const a = releaseArgs(rest, BUILD_USAGE);
      return releaseBuild(a.positional, a.dryRun);
    }
    case 'release:promote': {
      const a = releaseArgs(rest, PROMOTE_USAGE);
      return releasePromote(a.positional, a.dryRun);
    }
    default:
      throw new KitError(`Unknown command: ${command}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (e: unknown) => {
    if (e instanceof KitError) console.error(`!!  ${e.message}`);
    else console.error(e);
    process.exit(1);
  },
);
