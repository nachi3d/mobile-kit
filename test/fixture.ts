// A temporary app (git repo, app.json, mobile-kit.config.json, .maestro/)
// and every external command injected as test/fakes/fake.mjs. mk runs as a
// real process against it with MK_ROOT set, so release commands refuse to
// run without --dry-run and nothing can reach R2, EAS, Cloudflare or a device.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(KIT, 'dist', 'cli.js');
const FAKE = path.join(KIT, 'test', 'fakes', 'fake.mjs');

export const SHA1 = 'ab'.repeat(20);
export const SHA1_COLONS = SHA1.toUpperCase().match(/../g)!.join(':');
export const TOKEN = 'SECRET-PURGE-TOKEN-123';
export const APK_BYTES = 'PK\x03\x04....AndroidManifest.xml....';
/** The fake keystore's passwords: they must never appear in a command line or mk's output. */
export const STORE_PASSWORD = 'store-secret-4242';
export const KEY_PASSWORD = 'key-secret-4242';
/** eas.json of the fixture when a test asks for one: like BookTrack's (env per profile, extends). */
export const EAS_JSON = {
  cli: { version: '>= 16.0.0', appVersionSource: 'local' },
  build: {
    preview: { distribution: 'internal', android: { buildType: 'apk' }, env: { APP_ABIS: 'arm64-v8a,x86_64' } },
    production: { android: { buildType: 'apk' }, env: { APP_ABIS: 'arm64-v8a', SENTRY: 'off' } },
    universal: { extends: 'production', env: { APP_ABIS: 'all' } },
  },
};

export const BASE_CONFIG = {
  appName: 'ExampleApp',
  androidPackage: 'com.example.app',
  apkName: 'ExampleApp',
  r2Bucket: 'example-downloads',
  r2Prefix: 'exampleapp',
  downloadsHost: 'downloads.example.com',
  signingSha1: SHA1_COLONS,
  maestroDir: '.maestro',
  screens: ['home', 'settings'],
};

export interface Result {
  status: number | null;
  out: string;
}

export interface Fixture {
  root: string;
  avdHome: string;
  /** The production keystore folder (outside the fixture repo); MK_KEYSTORE_DIR points at it. */
  keystoreDir: string;
  /** A fake JDK 17 (bin/javac, release file); JAVA_HOME points at it. */
  jdkHome: string;
  /** Makes a fake Java home; `javac` false for a JRE. */
  makeJava(name: string, version: string, javac: boolean): string;
  run(args: string[], env?: Record<string, string | undefined>, input?: string): Result;
  /** mk running in the background (a test kills it). */
  start(args: string[], env?: Record<string, string | undefined>): ChildProcess;
  calls(): string;
  resetCalls(): void;
  state(): Record<string, string>;
  /** Changes the fake device's state (settings a killed run left behind, …). */
  setState(patch: Record<string, unknown>): void;
  write(file: string, content: string): void;
}

function git(root: string, ...args: string[]) {
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: root, stdio: 'pipe' });
}

export function makeFixture(
  options: {
    config?: Record<string, unknown>;
    withApk?: boolean;
    envLocal?: string | null;
    smoke?: Record<string, string>;
    /** expo.android.versionCode of app.json; null: none (EAS numbers the builds, like GameTrack). */
    versionCode?: number | null;
    /** eas.json content; none by default. */
    easJson?: Record<string, unknown>;
    /** Put the production keystore in keystoreDir (default true). */
    keystore?: boolean;
  } = {},
): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-test-'));
  const root = path.join(base, 'app');
  const log = path.join(base, 'calls.log');
  const stateFile = path.join(base, 'device.json');
  const avdHome = path.join(base, 'avd');
  fs.mkdirSync(avdHome);
  const makeJava = (name: string, version: string, javac: boolean) => {
    const home = path.join(base, 'java', name);
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, 'release'), `IMPLEMENTOR="Fake"\nJAVA_VERSION="${version}"\n`);
    fs.writeFileSync(path.join(home, 'bin', 'java.exe'), '');
    if (javac) fs.writeFileSync(path.join(home, 'bin', 'javac.exe'), '');
    return home;
  };
  const jdkHome = makeJava('jdk-17', '17.0.18', true);
  const keystoreDir = path.join(base, 'secrets', 'exampleapp');
  if (options.keystore ?? true) {
    fs.mkdirSync(keystoreDir, { recursive: true });
    fs.writeFileSync(path.join(keystoreDir, 'keystore.jks'), 'fake keystore');
    const keystore = { keystorePath: 'keystore.jks', keystorePassword: STORE_PASSWORD, keyAlias: 'upload', keyPassword: KEY_PASSWORD };
    fs.writeFileSync(path.join(keystoreDir, 'credentials.json'), JSON.stringify({ android: { keystore } }));
  }
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  fs.mkdirSync(root);
  fs.writeFileSync(log, '');
  const versionCode = options.versionCode === undefined ? 16 : options.versionCode;
  const android = { package: 'com.example.app', ...(versionCode !== null ? { versionCode } : {}) };
  write('app.json', JSON.stringify({ expo: { version: '0.2.0', android } }));
  if (options.easJson) write('eas.json', JSON.stringify(options.easJson, null, 2));
  write('mobile-kit.config.json', JSON.stringify({ ...BASE_CONFIG, ...options.config }, null, 2));
  write('.gitignore', 'dist/\n*.apk\n.env.local\n.images/\n/android\ncredentials.json\n*.jks\n');
  write('package.json', `${JSON.stringify({ name: 'example-app', scripts: { android: 'expo start --android' } }, null, 2)}\n`);
  const smoke = options.smoke ?? {
    '01-onboarding.yaml': 'appId: ${APP_ID}\n---\n- launchApp:\n    clearState: true\n',
    '02-add.yaml': 'appId: ${APP_ID}\n---\n- launchApp\n',
    '_helper.yaml': 'appId: ${APP_ID}\n---\n- back\n',
  };
  for (const [name, content] of Object.entries(smoke)) write(`.maestro/smoke/${name}`, content);
  write('.maestro/screens/home.yaml', 'appId: ${APP_ID}\n---\n- launchApp\n');
  write('.maestro/screens/settings.yaml', 'appId: ${APP_ID}\n---\n- launchApp\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'fixture');
  git(root, 'tag', 'v0.2.0');
  if (options.envLocal !== null) {
    fs.writeFileSync(path.join(root, '.env.local'), options.envLocal ?? `CF_ZONE_ID=zone123\nCF_PURGE_TOKEN=${TOKEN}\n`);
  }
  if (options.withApk ?? true) write('dist/ExampleApp-0.2.0.apk', APK_BYTES);

  const fake = (tool: string) => JSON.stringify([process.execPath, FAKE, tool]);
  const mkEnv = (env: Record<string, string | undefined>): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    MK_ROOT: root,
    MK_EAS: fake('eas'),
    MK_WRANGLER: fake('wrangler'),
    MK_CURL: fake('curl'),
    MK_ADB: fake('adb'),
    MK_MAESTRO: fake('maestro'),
    MK_AAPT: fake('aapt'),
    MK_APKSIGNER: fake('apksigner'),
    MK_OPEN: fake('open'),
    MK_EMULATOR: fake('emulator'),
    MK_AVDMANAGER: fake('avdmanager'),
    MK_PROCS: fake('procs'),
    MK_EXPO: fake('expo'),
    MK_GRADLEW: fake('gradlew'),
    MK_KEYTOOL: fake('keytool'),
    MK_KEYSTORE_DIR: keystoreDir,
    JAVA_HOME: jdkHome,
    FAKE_STOREPASS: STORE_PASSWORD,
    MK_POLL_MS: '20',
    MK_SETTLE_MS: '0',
    MK_STOP_TIMEOUT_MS: '500',
    ANDROID_AVD_HOME: avdHome,
    FAKE_LOG: log,
    FAKE_STATE: stateFile,
    FAKE_MAESTRO_TESTS: path.join(base, 'maestro-tests'),
    FAKE_PKG: 'com.example.app',
    FAKE_VC: '16',
    ...env, // an undefined value removes the variable
  });
  return {
    root,
    avdHome,
    keystoreDir,
    jdkHome,
    makeJava,
    write,
    run(args, env = {}, input = '') {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', input, env: mkEnv(env) });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    },
    start(args, env = {}) {
      return spawn(process.execPath, [CLI, ...args], { cwd: root, env: mkEnv(env), stdio: 'ignore' });
    },
    setState(patch) {
      const current = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
      fs.writeFileSync(stateFile, JSON.stringify({ ...current, ...patch }));
    },
    calls: () => fs.readFileSync(log, 'utf8'),
    resetCalls: () => fs.writeFileSync(log, ''),
    state: () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}),
  };
}

/** No fake with side effects ran (a dry run only prints them). */
export function sideEffects(calls: string): string[] {
  return calls
    .split('\n')
    .filter(
      (l) =>
        /^eas (?!build:list )/.test(l) ||
        /^wrangler /.test(l) ||
        /^maestro /.test(l) ||
        /^open /.test(l) ||
        /^(emulator|avdmanager) /.test(l) ||
        /^procs kill/.test(l) ||
        /^(expo|gradlew) /.test(l) ||
        /^eas credentials/.test(l) ||
        /^adb .*( install | uninstall | exec-out |emu kill|settings put global|dismiss-keyguard)/.test(l) ||
        /^adb .*(uimode night \S|settings (put|delete)|set-app-locales)/.test(l) ||
        /^curl .*(-X POST|-o )/.test(l),
    );
}
