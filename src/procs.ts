// Host processes, run by mk as its own tool (MK_PROCS, default `node
// dist/procs.js`) so tests replace it with a fake:
//
//   procs.js mem                   → {"freeMb": …, "emulatorMb": …}
//   procs.js kill-maestro <serial> → kills Maestro runs on that device
//   procs.js kill-emulator <avd>   → kills that AVD's emulator processes
//
// emulatorMb is the private memory (Windows) or resident size (macOS,
// Linux) of the qemu-system processes: the number that grew past 14 GB with
// software rendering.
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const SAFE = /^[\w.-]+$/;

function powershell(script: string): string {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return r.stdout ?? '';
}

function emulatorMb(): number {
  if (process.platform === 'win32') {
    const out = powershell(
      '(Get-Process qemu-system* -ErrorAction SilentlyContinue | Measure-Object PrivateMemorySize64 -Sum).Sum',
    );
    return Math.round((Number(out.trim()) || 0) / 1024 / 1024);
  }
  const r = spawnSync('ps', ['-A', '-o', 'rss=,comm='], { encoding: 'utf8' });
  let kb = 0;
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m?.[1] && m[2]?.includes('qemu-system')) kb += Number(m[1]);
  }
  return Math.round(kb / 1024);
}

/** Kills every process whose command line contains all of `parts`; returns how many. */
function killMatching(parts: string[]): number {
  if (process.platform === 'win32') {
    const conditions = parts.map((p) => `$_.CommandLine -like '*${p}*'`).join(' -and ');
    const out = powershell(
      `$n = 0; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne $PID -and ${conditions} } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; $n`,
    );
    return Number(out.trim()) || 0;
  }
  const r = spawnSync('pkill', ['-9', '-f', parts.map((p) => p.replace(/[.]/g, '\\.')).join('.*')], { encoding: 'utf8' });
  return r.status === 0 ? 1 : 0;
}

const [command, arg] = process.argv.slice(2);
if (command === 'mem') {
  console.log(JSON.stringify({ freeMb: Math.round(os.freemem() / 1024 / 1024), emulatorMb: emulatorMb() }));
} else if ((command === 'kill-maestro' || command === 'kill-emulator') && arg && SAFE.test(arg)) {
  const n = command === 'kill-maestro' ? killMatching(['maestro', `--device ${arg}`]) : killMatching([`-avd ${arg}`]);
  console.log(String(n));
} else {
  console.error('Usage: procs.js mem | kill-maestro <serial> | kill-emulator <avd>');
  process.exit(2);
}
