// The production signing key on this computer, for local builds.
//
// It lives OUTSIDE every repository, in MK_KEYSTORE_DIR (from the
// environment or the app's gitignored .env.local), as `mk keystore:pull`
// writes it:
//
//   <MK_KEYSTORE_DIR>/credentials.json                   EAS's file, unchanged
//   <MK_KEYSTORE_DIR>/credentials/android/keystore.jks   its keystorePath, relative to the folder
//
// (An older pull wrote keystorePath "keystore.jks" next to credentials.json:
// any relative keystorePath is read against MK_KEYSTORE_DIR.)
//
// Passwords only ever reach child processes through their environment:
// never on a command line, in a file of the app, or printed.
import fs from 'node:fs';
import path from 'node:path';

import { normalizeSha1 } from './config.js';
import { act, run } from './exec.js';
import { detail, fail, info, KitError, warn } from './log.js';
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

/**
 * The certificate SHA-1 in `keytool -list -v` output, normalized, or null.
 * English prints "SHA1:", some JDK translations "SHA 1:" (French) or "SHA-1:".
 */
export function parseKeytoolSha1(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*SHA[\s-]?1\s*:\s*(\S+)/i.exec(line);
    if (m?.[1]) return normalizeSha1(m[1]);
  }
  return null;
}

const KEYTOOL_HINT = 'install a JDK 17+ (or Android Studio), or set MK_KEYTOOL to keytool';

/** The last lines a tool printed, every occurrence of `secret` masked. */
function excerpt(text: string, secret: string): string {
  const lines = text.split(secret).join('***').trim().split('\n').slice(-5);
  return lines[0] ? `\n      ${lines.join('\n      ')}` : '';
}

/**
 * The key's certificate SHA-1, read by keytool. keytool is spawned without a
 * shell and gets the password through its environment (-storepass:env): no
 * character of it is interpreted by cmd.exe or bash, and it is in no command
 * line. Its output is in English whatever the system language.
 */
export function keystoreSha1(p: Project, s: Pick<Signing, 'storeFile' | 'storePassword' | 'keyAlias'>): string {
  if (p.tool.keytool.length === 0) {
    fail(`keytool not found (looked in PATH, JAVA_HOME\\bin, Android Studio\\jbr\\bin): ${KEYTOOL_HINT}`);
  }
  const args = ['-J-Duser.language=en', '-J-Duser.country=US', '-list', '-v', '-keystore', s.storeFile, '-alias', s.keyAlias];
  const r = run(p.tool.keytool, [...args, '-storepass:env', 'MK_KEYTOOL_STOREPASS'], {
    env: { ...process.env, MK_KEYTOOL_STOREPASS: s.storePassword },
  });
  if (r.status === 127) fail(`keytool could not be started (${p.tool.keytool.join(' ')}): ${KEYTOOL_HINT}`);
  if (r.status !== 0) {
    fail(
      `keytool cannot read ${s.storeFile} (exit code ${r.status}: wrong password or alias, or not a keystore)` +
        excerpt(r.stderr || r.stdout, s.storePassword),
    );
  }
  const sha1 = parseKeytoolSha1(`${r.stdout}\n${r.stderr}`);
  if (!sha1) fail(`keytool printed no SHA-1 fingerprint (exit code 0)${excerpt(r.stderr, s.storePassword)}`);
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

/** Where `eas credentials` puts the keystore, relative to the app folder. */
const EAS_KEYSTORE = path.join('credentials', 'android', 'keystore.jks');

const gitIgnored = (root: string, file: string) => run(['git'], ['-C', root, 'check-ignore', '-q', file]).status === 0;

/** `file` relative to `dir` when it lies inside it, else null. */
function inside(dir: string, file: string): string | null {
  const rel = path.relative(dir, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
}

/** `file`, or `name-1.ext`, `name-2.ext`… : the first that does not exist. */
function freePath(file: string): string {
  const ext = path.extname(file);
  let candidate = file;
  for (let i = 1; fs.existsSync(candidate); i++) candidate = `${file.slice(0, file.length - ext.length)}-${i}${ext}`;
  return candidate;
}

/** Moves `from` to `to` (a free path): a rename, or across drives copy, check the size, delete. */
function moveFile(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
  }
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  if (fs.statSync(to).size !== fs.statSync(from).size) fail(`Copying ${from} to ${to} failed: both are kept, delete the copy`);
  fs.rmSync(from);
}

/** Removes the empty folders above `file`, up to `stop`. */
function removeEmptyParents(file: string, stop: string): void {
  for (let dir = path.dirname(file); inside(stop, dir); dir = path.dirname(dir)) {
    if (!fs.existsSync(dir) || fs.readdirSync(dir).length > 0) break;
    fs.rmdirSync(dir);
  }
}

/**
 * Moves what `eas credentials` downloaded from the app folder to `dir`,
 * whatever it contains (even invalid): the keystore keeps its path relative
 * to the app (credentials/android/keystore.jks), credentials.json goes next
 * to it unchanged. keystorePath is rewritten only when it would no longer
 * name the key from `dir`. Returns the moved credentials.json, or null.
 */
function moveDownloads(root: string, dir: string): string | null {
  const downloaded = path.join(root, 'credentials.json');
  let json: CredentialsJson | null = null;
  if (fs.existsSync(downloaded)) {
    try {
      json = JSON.parse(fs.readFileSync(downloaded, 'utf8')) as CredentialsJson;
    } catch {
      json = null;
    }
  }
  const k = json?.android?.keystore;
  const declared = typeof k?.keystorePath === 'string' && k.keystorePath !== '' ? k.keystorePath : null;
  const declaredFrom = declared ? path.resolve(root, declared) : null;

  let keyAt = declaredFrom && fs.existsSync(declaredFrom) ? declaredFrom : null;
  for (const from of new Set([path.join(root, EAS_KEYSTORE), ...(declaredFrom ? [declaredFrom] : [])])) {
    const rel = inside(root, from);
    if (!rel || !fs.existsSync(from)) continue;
    const to = freePath(path.join(dir, rel));
    moveFile(from, to);
    removeEmptyParents(from, root);
    if (from === declaredFrom) keyAt = to;
  }

  if (!fs.existsSync(downloaded)) return null;
  const target = path.join(dir, 'credentials.json');
  if (k && declared && keyAt && path.resolve(dir, declared) !== keyAt) {
    k.keystorePath = inside(dir, keyAt)?.split(path.sep).join('/') ?? keyAt;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(json, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.rmSync(downloaded);
  } else {
    moveFile(downloaded, target);
  }
  return target;
}

/**
 * mk keystore:pull — run by hand, once per computer. `eas credentials`
 * (interactive) downloads the production keystore and its passwords into
 * the app folder (credentials.json + credentials/android/keystore.jks, both
 * gitignored); mk moves them at once to MK_KEYSTORE_DIR, outside every
 * repository, then checks the certificate against mobile-kit.config.json.
 * Files an earlier pull left in the app folder are moved without running
 * eas. Whatever fails, nothing stays in the app folder and the pulled files
 * are never deleted.
 */
export async function keystorePull(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const unknown = args.find((a) => a !== '--dry-run');
  if (unknown) fail(`Unknown option: ${unknown}. ${KEYSTORE_PULL_USAGE}`);
  const p = openProject({ dryRun, requireDryRunInFixture: false });
  const dir = keystoreDir(p.root);
  requireOutsideRepos(dir);
  for (const f of ['credentials.json', EAS_KEYSTORE]) {
    if (fs.existsSync(path.join(dir, f))) fail(`${path.join(dir, f)} already exists. To pull again, delete ${dir} first.`);
  }
  for (const f of ['credentials.json', 'credentials/android/keystore.jks']) {
    if (!gitIgnored(p.root, f)) fail(`${f} is not gitignored in this app. Add "credentials.json" and "credentials/" to .gitignore first.`);
  }

  const downloaded = path.join(p.root, 'credentials.json');
  if (fs.existsSync(downloaded)) {
    info(`${downloaded} is already here (an earlier download): mk moves it to ${dir}, eas is not run.`);
  } else {
    info(`eas credentials: answer as below. EAS writes the files here; mk moves them to ${dir} right after.`);
    detail('Which build profile do you want to configure? → production');
    detail('What do you want to do? → credentials.json: Upload/Download credentials between EAS servers and your local json');
    detail('→ Download credentials from EAS to credentials.json');
    detail('Then: Go back → Exit.');
    if (act(dryRun, p.tool.eas, ['credentials', '-p', 'android'], { cwd: p.root, interactive: true }).status !== 0) {
      warn('eas credentials ended with an error');
    }
  }
  if (dryRun) return;

  if (!moveDownloads(p.root, dir)) {
    fail('No credentials.json was downloaded: run it again and choose "Download credentials from EAS".');
  }
  try {
    loadSigning(p);
  } catch (e) {
    if (!(e instanceof KitError)) throw e;
    fail(
      `${e.message}\n    The pulled files are kept in ${dir} (nothing is left in the app folder). ` +
        `Once fixed: npm run build:local -- --profile <profile> --dry-run checks them; to pull again, delete ${dir} first.`,
    );
  }
  info(`Saved in ${dir}; nothing is left in the app folder.`);
  detail('Keep a copy of that folder somewhere safe (password manager, encrypted drive): the key can never change.');
}
