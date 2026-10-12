// One fake for every external command: `node fake.mjs <tool> <args…>`.
// Logs each call to FAKE_LOG; adb keeps device state in FAKE_STATE (JSON).
// Nothing here touches the network, a device or any real service.
import fs from 'node:fs';

const [tool, ...args] = process.argv.slice(2);
const env = process.env;
const line = args.join(' ');
fs.appendFileSync(env.FAKE_LOG, `${tool} ${line}\n`);

const out = (s) => process.stdout.write(s);
const failIf = (name) => (env.FAKE_FAIL ?? '').split(',').includes(name);

// 1×1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function state() {
  const initial = {
    night: env.FAKE_NIGHT ?? 'no',
    font_scale: env.FAKE_FONT_SCALE ?? 'null',
    locales: env.FAKE_LOCALES ?? '',
    versionCode: env.FAKE_INSTALLED_VC ?? '15',
    emulator: env.FAKE_EMULATOR_RUNNING ?? '',
    // Package whose "isn't responding" dialog has the focus ('' = none).
    anr: env.FAKE_ANR ?? '',
    memCalls: 0,
    boots: 0,
    // Maestro's driver on the device: ok, broken (a reinstall fixes it) or dead (nothing does).
    driver: 'ok',
  };
  if (!env.FAKE_STATE) return initial;
  if (!fs.existsSync(env.FAKE_STATE)) fs.writeFileSync(env.FAKE_STATE, JSON.stringify(initial));
  return JSON.parse(fs.readFileSync(env.FAKE_STATE, 'utf8'));
}
const save = (s) => env.FAKE_STATE && fs.writeFileSync(env.FAKE_STATE, JSON.stringify(s));

/**
 * What Maestro prints when a flow fails: the failed step, its error, the
 * debug folder (created under FAKE_MAESTRO_TESTS), then the Maestro Cloud
 * box whose frame a Windows console shows as "?".
 */
function failFlow(name, step, error) {
  let debug = '';
  if (env.FAKE_MAESTRO_TESTS) {
    const n = fs.existsSync(env.FAKE_MAESTRO_TESTS) ? fs.readdirSync(env.FAKE_MAESTRO_TESTS).length : 0;
    debug = `${env.FAKE_MAESTRO_TESTS}/2026-10-12_0037${String(n).padStart(2, '0')}`;
    fs.mkdirSync(`${debug}/${name}`, { recursive: true });
    fs.writeFileSync(`${debug}/maestro.log`, `[ERROR] ${error}\n`);
    fs.writeFileSync(`${debug}/${name}/screenshot-failed.png`, PNG);
  }
  out(`Running on mk-pixel8-api34\n > Flow ${name}\nLaunch app "\${APP_ID}"... COMPLETED\n${step}... FAILED\n\n${error}\n\n`);
  out('Possible causes:\n- Element selector may be incorrect.\n\n');
  if (debug) out(`==== Debug output (logs & screenshots) ====\n\n${debug}\n`);
  out(`${'?'.repeat(40)}\n?${' '.repeat(38)}?\n?   Run your flows on Maestro Cloud:   ?\n?   maestro cloud app_file flows_folder/ ?\n${'?'.repeat(40)}`);
  process.exit(1);
}

switch (tool) {
  case 'eas':
    out(JSON.stringify([{ status: 'FINISHED', artifacts: { applicationArchiveUrl: 'https://expo.invalid/build.apk' } }]));
    break;
  case 'wrangler':
  case 'open':
    break;
  case 'emulator': {
    // FAKE_FAIL=emulator:<gpu>: that GPU mode does not boot (exit 1).
    if (failIf(`emulator:${args[args.indexOf('-gpu') + 1]}`)) process.exit(1);
    const s = state();
    s.emulator = args[args.indexOf('-avd') + 1];
    s.boots += 1;
    // FAKE_DRIVER_BROKEN_BOOTS / FAKE_BAD_BOOTS="2,3": after those boots Maestro cannot reach the device.
    const on = (name) => (env[name] ?? '').split(',').includes(String(s.boots));
    s.driver = on('FAKE_BAD_BOOTS') ? 'dead' : on('FAKE_DRIVER_BROKEN_BOOTS') ? 'broken' : 'ok';
    save(s);
    break;
  }
  case 'procs': {
    if (args[0] === 'mem') {
      // FAKE_MEM_SEQ="free:emu,free:emu,…": one pair per call, the last one repeats.
      const s = state();
      const seq = (env.FAKE_MEM_SEQ ?? '8000:2000').split(',');
      const [free, emu] = seq[Math.min(s.memCalls, seq.length - 1)].split(':').map(Number);
      s.memCalls += 1;
      save(s);
      out(JSON.stringify({ freeMb: free, emulatorMb: emu }));
    } else if (args[0] === 'kill-emulator') {
      const s = state();
      s.emulator = '';
      save(s);
      out('2\n');
    } else out(`${env.FAKE_KILLED ?? '0'}\n`);
    break;
  }
  case 'avdmanager': {
    if (failIf('avdmanager')) {
      process.stderr.write('Error: Package path is not valid. Valid system image paths are: null\n');
      process.exit(1);
    }
    const name = args[args.indexOf('-n') + 1];
    const home = env.ANDROID_AVD_HOME;
    fs.mkdirSync(`${home}/${name}.avd`, { recursive: true });
    fs.writeFileSync(`${home}/${name}.ini`, `path=${home}/${name}.avd\n`);
    fs.writeFileSync(`${home}/${name}.avd/config.ini`, 'hw.ramSize=2G\nhw.keyboard=no\ndisk.dataPartition.size=10G\nhw.device.name=pixel_8\n');
    break;
  }
  case 'curl': {
    if (args[0] === '-sI') {
      out(`HTTP/1.1 ${env.FAKE_HEAD_STATUS ?? '404'} Status\r\ncontent-length: ${env.FAKE_HEAD_LENGTH ?? '0'}\r\n\r\n`);
      break;
    }
    const o = args.indexOf('-o');
    if (o >= 0) {
      fs.writeFileSync(args[o + 1], 'PK\x03\x04....AndroidManifest.xml....');
      break;
    }
    process.exit(1);
  }
  case 'aapt':
    out(
      `package: name='${env.FAKE_PKG ?? 'com.example.app'}' versionCode='${env.FAKE_VC ?? '15'}' versionName='${env.FAKE_VN ?? '0.2.0'}' platformBuildVersionName='16'\n`,
    );
    break;
  case 'apksigner':
    if (env.FAKE_UNSIGNED) {
      out('DOES NOT VERIFY\n');
      process.exit(1);
    }
    out(`Verifies\nSigner #1 certificate DN: CN=Expo\nSigner #1 certificate SHA-1 digest: ${env.FAKE_SHA1 ?? 'ab'.repeat(20)}\n`);
    break;
  case 'maestro': {
    if (args.includes('hierarchy')) {
      if (state().driver !== 'ok') {
        process.stderr.write('Failed to connect to the device: io.grpc.StatusRuntimeException: UNAVAILABLE\n');
        process.exit(1);
      }
      out('{ "attributes": { "resource-id": "" }, "children": [] }\n');
      break;
    }
    const flow = args[args.indexOf('test') + 1] ?? '';
    const name = flow.replace(/\\/g, '/').split('/').pop().replace(/\.ya?ml$/, '');
    // FAKE_MAESTRO_MS: each flow takes that long (a test kills mk meanwhile).
    if (env.FAKE_MAESTRO_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(env.FAKE_MAESTRO_MS));
    // FAKE_JVM_CRASH: the JVM leaves a crash dump in its working folder.
    if (env.FAKE_JVM_CRASH) fs.writeFileSync('hs_err_pid4242.log', '# A fatal error has been detected\n');
    const s = state();
    // FAKE_ANR_DURING=<flow>: the launcher stops responding during that flow (once).
    if (env.FAKE_ANR_DURING === name && !s.anrShown) {
      s.anr = 'com.google.android.apps.nexuslauncher';
      s.anrShown = true;
      save(s);
    }
    if (s.anr) failFlow(name, 'Tap on id: tab-home', 'Element not found: an ANR dialog covers the app');
    if (s.driver !== 'ok') failFlow(name, 'Launch app "${APP_ID}"', 'Unable to launch app com.example.app');
    if (failIf(`maestro:${name}`)) failFlow(name, 'Tap on id: missing-thing', 'Element not found: Id matching regex: missing-thing');
    out(`Running ${name}\nFlow passed\n`);
    break;
  }
  case 'adb': {
    if (args[0] === 'devices') {
      out('List of devices attached\r\n');
      for (const d of (env.FAKE_ADB_DEVICES ?? '').split(' ').filter(Boolean)) out(`${d}\tdevice\r\n`);
      if (env.FAKE_ADB_UNAUTHORIZED) out(`${env.FAKE_ADB_UNAUTHORIZED}\tunauthorized\r\n`);
      if (state().emulator) out('emulator-5554\tdevice\r\n');
      break;
    }
    const rest = args.slice(2); // after -s <serial>
    const cmd = rest.join(' ');
    const s = state();
    if (rest[0] === 'emu') {
      if (rest[1] === 'avd') out(`${s.emulator || 'other-avd'}\r\nOK\r\n`);
      if (rest[1] === 'kill' && !failIf('emu-kill')) {
        s.emulator = '';
        save(s);
      }
    } else if (cmd === 'shell getprop sys.boot_completed') out('1\n');
    else if (rest[0] === 'uninstall') {
      if (rest[1] === 'dev.mobile.maestro' && s.driver === 'broken') s.driver = 'ok';
      save(s);
    } else if (rest[0] === 'install') {
      s.versionCode = env.FAKE_APK_VC ?? '16';
      save(s);
    } else if (rest[0] === 'exec-out' && rest[1] === 'uiautomator') {
      if (s.anr) {
        out('<?xml version="1.0"?><hierarchy><node resource-id="android:id/aerr_close" bounds="[66,1170][1014,1302]"/>');
        out('<node text="Wait" resource-id="android:id/aerr_wait" bounds="[66,1302][1014,1434]"/></hierarchy>');
      }
    } else if (cmd === 'shell input tap 540 1368') {
      s.anr = '';
      save(s);
    } else if (cmd === 'shell dumpsys window windows') {
      out(s.anr ? `  mCurrentFocus=Window{42f u0 Application Not Responding: ${s.anr}}\n` : '  mCurrentFocus=Window{a1e u0 launcher}\n');
    } else if (rest[0] === 'exec-out') {
      if (failIf('screencap')) process.exit(1);
      process.stdout.write(PNG);
    } else if (cmd.includes('dumpsys package')) {
      out(`    versionCode=${s.versionCode} minSdk=24 targetSdk=36\n`);
    } else if (cmd.includes('getprop ro.product.model')) out('Pixel Test\n');
    else if (cmd.includes('getprop ro.product.manufacturer')) out('Google\n');
    else if (cmd.includes('getprop ro.build.version.release')) out('15\n');
    else if (cmd.includes('getprop ro.build.version.sdk')) out(`${env.FAKE_SDK ?? '35'}\n`);
    else if (cmd === 'shell cmd uimode night') out(`Night mode: ${s.night}\n`);
    else if (cmd.startsWith('shell cmd uimode night ')) {
      s.night = rest[4];
      save(s);
    } else if (cmd === 'shell settings get system font_scale') out(`${s.font_scale}\n`);
    else if (cmd.startsWith('shell settings put system font_scale ')) {
      if (failIf('font_scale')) process.exit(1);
      s.font_scale = rest[5];
      save(s);
    } else if (cmd === 'shell settings delete system font_scale') {
      s.font_scale = 'null';
      save(s);
    } else if (cmd.includes('get-app-locales')) out(`Locales for x for user 0 are [${s.locales}]\n`);
    else if (cmd.includes('set-app-locales')) {
      const v = rest[rest.indexOf('--locales') + 1];
      s.locales = v === '""' ? '' : v;
      save(s);
    }
    break;
  }
  default:
    process.stderr.write(`fake: unknown tool ${tool}\n`);
    process.exit(2);
}
