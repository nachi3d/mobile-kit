#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCommand, LOCAL_BUILD_USAGE } from './build/local.js';
import { EMULATOR_USAGE, ensureEmulator, parseEmulatorArgs } from './emulator.js';
import { KEYSTORE_PULL_USAGE, keystorePull } from './keystore.js';
import { KitError } from './log.js';
import { openProject } from './project.js';
import { qaDevice, QA_USAGE } from './qa/device.js';
import { BUILD_USAGE, releaseBuild } from './release/build.js';
import { PROMOTE_USAGE, releasePromote } from './release/promote.js';
const version = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;
const HELP = `mobile-kit ${version}: device QA and APK releases for Expo apps.

  ${QA_USAGE}
  ${EMULATOR_USAGE}
  ${BUILD_USAGE}
  ${PROMOTE_USAGE}
  ${LOCAL_BUILD_USAGE}
  ${KEYSTORE_PULL_USAGE}

Run from the app folder (it has mobile-kit.config.json). See the README.`;
/** --dry-run (and `flags`) plus positionals; anything else starting with "-" is refused. */
function releaseArgs(args, usage, flags = []) {
    const positional = [];
    const set = new Set();
    let dryRun = false;
    for (const a of args) {
        if (a === '--dry-run')
            dryRun = true;
        else if (flags.includes(a))
            set.add(a);
        else if (a.startsWith('-'))
            throw new KitError(`Unknown option: ${a}. ${usage}`);
        else
            positional.push(a);
    }
    return { positional, dryRun, flags: set };
}
async function main(argv) {
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
            const a = releaseArgs(rest, BUILD_USAGE, ['--local']);
            return releaseBuild(a.positional, a.dryRun, a.flags.has('--local'));
        }
        case 'build':
            return buildCommand(rest);
        case 'keystore:pull':
            return keystorePull(rest);
        case 'release:promote': {
            const a = releaseArgs(rest, PROMOTE_USAGE);
            return releasePromote(a.positional, a.dryRun);
        }
        default:
            throw new KitError(`Unknown command: ${command}\n\n${HELP}`);
    }
}
main(process.argv.slice(2)).then(() => process.exit(0), (e) => {
    if (e instanceof KitError)
        console.error(`!!  ${e.message}`);
    else
        console.error(e);
    process.exit(1);
});
