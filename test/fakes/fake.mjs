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
  };
  if (!env.FAKE_STATE) return initial;
  if (!fs.existsSync(env.FAKE_STATE)) fs.writeFileSync(env.FAKE_STATE, JSON.stringify(initial));
  return JSON.parse(fs.readFileSync(env.FAKE_STATE, 'utf8'));
}
const save = (s) => env.FAKE_STATE && fs.writeFileSync(env.FAKE_STATE, JSON.stringify(s));

switch (tool) {
  case 'eas':
    out(JSON.stringify([{ status: 'FINISHED', artifacts: { applicationArchiveUrl: 'https://expo.invalid/build.apk' } }]));
    break;
  case 'wrangler':
  case 'open':
    break;
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
    const flow = args[args.indexOf('test') + 1] ?? '';
    const name = flow.replace(/\\/g, '/').split('/').pop().replace(/\.ya?ml$/, '');
    if (failIf(`maestro:${name}`)) {
      out(`Running ${name}\nAssertion is false: id: missing-thing is visible\n`);
      process.exit(1);
    }
    out(`Running ${name}\nFlow passed\n`);
    break;
  }
  case 'adb': {
    if (args[0] === 'devices') {
      out('List of devices attached\r\n');
      for (const d of (env.FAKE_ADB_DEVICES ?? '').split(' ').filter(Boolean)) out(`${d}\tdevice\r\n`);
      if (env.FAKE_ADB_UNAUTHORIZED) out(`${env.FAKE_ADB_UNAUTHORIZED}\tunauthorized\r\n`);
      break;
    }
    const rest = args.slice(2); // after -s <serial>
    const cmd = rest.join(' ');
    const s = state();
    if (rest[0] === 'install') {
      s.versionCode = env.FAKE_APK_VC ?? '16';
      save(s);
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
