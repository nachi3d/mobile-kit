// The production signing key on this computer, for local builds.
//
// It lives OUTSIDE every repository, in MK_KEYSTORE_DIR (from the
// environment or the app's gitignored .env.local), as `mk keystore:pull`
// writes it:
//
//   <MK_KEYSTORE_DIR>/credentials.json   EAS's format, keystorePath "keystore.jks"
//   <MK_KEYSTORE_DIR>/keystore.jks
//
// Passwords only ever reach child processes through their environment:
// never on a command line, in a file of the app, or printed.
import fs from 'node:fs';
import path from 'node:path';

import { normalizeSha1 } from './config.js';
import { act, run } from './exec.js';
import { detail, fail, info, warn } from './log.js';
import { openProject, readEnvLocalValue, type Project } from './project.js';

export const KEYSTORE_PULL_USAGE = 'Usage: mk keystore:pull [--dry-run]';

export interface Signing {
  dir: string;
  storeFile: string;
  storePassword: string;
  keyAlias: string;
  keyPassword: string;
}

interface CredentialsJson {
  android?: { keystore?: { keystorePath?: unknown; keystorePassword?: unknown; keyAlias?: unknown; keyPassword?: unknown } };
}

const SETUP_HINT = 'mobile-kit README → Local builds → Keystore (once)';

/** MK_KEYSTORE_DIR from the environment, else from .env.local; a stop when neither has it. */
export function keystoreDir(root: string): string {
  const value = process.env.MK_KEYSTORE_DIR || readEnvLocalValue(root, 'MK_KEYSTORE_DIR');
  if (!value) {
    fail(`MK_KEYSTORE_DIR is not set: add it to .env.local, e.g. MK_KEYSTORE_DIR=D:\\Dev\\secrets\\<app>. ${SETUP_HINT}`);
  }
  return path.resolve(value);
}

/** The top folder of the git repository holding `dir` (or its nearest existing parent), or null. */
function enclosingRepo(dir: string): string | null {
  let probe = dir;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
  const r = run(['git'], ['-C', probe, 'rev-parse', '--show-toplevel']);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** The keystore folder is never inside a repository: a `git add .` would publish the key. */
export function requireOutsideRepos(dir: string): void {
  const repo = enclosingRepo(dir);
  if (repo) fail(`MK_KEYSTORE_DIR (${dir}) is inside the git repository ${repo}. Keep the keystore outside every repository.`);
}

function parseCredentials(file: string): Omit<Signing, 'dir'> {
  let json: CredentialsJson;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8')) as CredentialsJson;
  } catch {
    fail(`${file} is not valid JSON`);
  }
  const k = json.android?.keystore;
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  const storePath = text(k?.keystorePath);
  const storePassword = text(k?.keystorePassword);
  const keyAlias = text(k?.keyAlias);
  const keyPassword = text(k?.keyPassword);
  if (!storePath || !storePassword || !keyAlias || !keyPassword) {
    fail(`${file} lacks android.keystore keystorePath / keystorePassword / keyAlias / keyPassword`);
  }
  return { storeFile: path.resolve(path.dirname(file), storePath), storePassword, keyAlias, keyPassword };
}

/** The key's certificate SHA-1, read by keytool (the password goes through its environment). */
export function keystoreSha1(p: Project, s: Pick<Signing, 'storeFile' | 'storePassword' | 'keyAlias'>): string {
  const args = ['-list', '-v', '-keystore', s.storeFile, '-alias', s.keyAlias, '-storepass:env', 'MK_KEYTOOL_STOREPASS'];
  const r = run(p.tool.keytool, args, { env: { ...process.env, MK_KEYTOOL_STOREPASS: s.storePassword } });
  if (r.status !== 0) {
    fail(`keytool cannot read ${s.storeFile} (wrong password or alias, or no JDK: set JAVA_HOME to a JDK 17)`);
  }
  const line = `${r.stdout}\n${r.stderr}`.split('\n').find((l) => /^\s*SHA-?1:/i.test(l)) ?? '';
  const sha1 = normalizeSha1(line.replace(/^\s*SHA-?1:\s*/i, '').trim());
  if (!sha1) fail('keytool printed no SHA-1 fingerprint');
  return sha1;
}

/**
 * The production key, checked: files present, and its certificate is the
 * one mobile-kit.config.json names (the key every published APK carries).
 * Read-only, so a dry run checks it too.
 */
export function loadSigning(p: Project): Signing {
  const dir = keystoreDir(p.root);
  requireOutsideRepos(dir);
  const file = path.join(dir, 'credentials.json');
  if (!fs.existsSync(file)) fail(`No ${file}. Run once: npm run keystore:pull (${SETUP_HINT})`);
  const s = { dir, ...parseCredentials(file) };
  if (!fs.existsSync(s.storeFile)) fail(`Keystore missing: ${s.storeFile}`);
  const expected = normalizeSha1(p.config.signingSha1);
  const actual = keystoreSha1(p, s);
  if (actual !== expected) {
    fail(
      `The keystore in ${dir} has certificate SHA-1 ${actual}, mobile-kit.config.json says ${expected}. ` +
        'Not the production key: pull it again (Android → production profile).',
    );
  }
  info(`Signing key OK: ${dir} (certificate SHA-1 matches mobile-kit.config.json)`);
  return s;
}

// ---------------------------------------------------------------- keystore:pull

const gitIgnored = (root: string, file: string) => run(['git'], ['-C', root, 'check-ignore', '-q', file]).status === 0;

/** Removes `file`, then its parent folders up to `stop` while they are empty. */
function removeUp(file: string, stop: string): void {
  fs.rmSync(file, { force: true });
  for (let dir = path.dirname(file); dir.startsWith(stop) && dir !== stop; dir = path.dirname(dir)) {
    if (!fs.existsSync(dir) || fs.readdirSync(dir).length > 0) break;
    fs.rmdirSync(dir);
  }
}

/**
 * mk keystore:pull — run by hand, once per computer. `eas credentials`
 * (interactive) downloads the production keystore and its passwords into
 * the app folder (credentials.json + credentials/android/keystore.jks, both
 * gitignored); mk moves them at once to MK_KEYSTORE_DIR, outside every
 * repository, and checks the certificate against mobile-kit.config.json.
 */
export async function keystorePull(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const unknown = args.find((a) => a !== '--dry-run');
  if (unknown) fail(`Unknown option: ${unknown}. ${KEYSTORE_PULL_USAGE}`);
  const p = openProject({ dryRun, requireDryRunInFixture: false });
  const dir = keystoreDir(p.root);
  requireOutsideRepos(dir);
  const target = path.join(dir, 'credentials.json');
  if (fs.existsSync(target)) fail(`${target} already exists. To pull again, delete ${dir} first.`);

  const downloaded = path.join(p.root, 'credentials.json');
  if (fs.existsSync(downloaded)) fail(`${downloaded} already exists: move or delete it first (mk never overwrites it).`);
  for (const f of ['credentials.json', 'credentials/android/keystore.jks']) {
    if (!gitIgnored(p.root, f)) fail(`${f} is not gitignored in this app. Add "credentials.json" and "*.jks" to .gitignore first.`);
  }

  info(`eas credentials: answer as below. EAS writes the files here; mk moves them to ${dir} right after.`);
  detail('Which build profile do you want to configure? → production');
  detail('What do you want to do? → credentials.json: Upload/Download credentials between EAS servers and your local json');
  detail('→ Download credentials from EAS to credentials.json');
  detail('Then: Go back → Exit.');
  if (act(dryRun, p.tool.eas, ['credentials', '-p', 'android'], { cwd: p.root, interactive: true }).status !== 0) {
    warn('eas credentials ended with an error');
  }
  if (dryRun) return;

  let keystoreFrom: string | null = null;
  try {
    if (!fs.existsSync(downloaded)) fail('No credentials.json was downloaded: run it again and choose "Download credentials from EAS".');
    const creds = parseCredentials(downloaded);
    keystoreFrom = creds.storeFile;
    if (!fs.existsSync(keystoreFrom)) fail(`credentials.json points to ${keystoreFrom}, which is missing`);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(keystoreFrom, path.join(dir, 'keystore.jks'));
    const json = {
      android: {
        keystore: {
          keystorePath: 'keystore.jks',
          keystorePassword: creds.storePassword,
          keyAlias: creds.keyAlias,
          keyPassword: creds.keyPassword,
        },
      },
    };
    fs.writeFileSync(target, `${JSON.stringify(json, null, 2)}\n`, { mode: 0o600 });
  } finally {
    // Never leave the key in the app folder, whatever happened.
    if (keystoreFrom && path.resolve(keystoreFrom).startsWith(p.root)) removeUp(keystoreFrom, p.root);
    fs.rmSync(downloaded, { force: true });
    removeUp(path.join(p.root, 'credentials', 'android', 'keystore.jks'), p.root);
  }

  try {
    loadSigning(p);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  info(`Saved in ${dir} (credentials.json + keystore.jks); nothing is left in the app folder.`);
  detail('Keep a copy of that folder somewhere safe (password manager, encrypted drive): the key can never change.');
}
