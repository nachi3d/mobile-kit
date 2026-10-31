import type { DeviceInfo } from '../android.js';

export interface FlowResult {
  flow: string;
  ok: boolean;
  seconds: number;
  /** Last lines of Maestro's output when it failed (its Cloud box removed). */
  error?: string;
  /** The step that failed and why, e.g. "Tap on id: x: Element not found: …". */
  errorLine?: string;
  /** Copy of Maestro's debug folder, relative to the report. */
  debug?: string;
}

export interface Shot {
  screen: string;
  mode: string;
  lang: string;
  scale: number;
  /** Relative to the report; absent when the capture failed or did not run yet. */
  file?: string;
  error?: string;
  /** Copy of Maestro's debug folder of the failed flow, relative to the report. */
  debug?: string;
}

/** Device settings read before the matrix and put back after it. */
export interface SavedSettings {
  night: string;
  fontScale: string;
  appLocales: string | null;
  /** Window, transition and animator scales ("null" = never set); absent in runs before 0.3.2. */
  animations?: string[];
}

/** --migration-from: the old APK, its seed flow, the upgrade, the verify flow. */
export interface MigrationRun {
  /** The old APK's file name. */
  from: string;
  fromVersionCode: number | null;
  seed?: FlowResult;
  verify?: FlowResult;
}

export interface QaRun {
  appName: string;
  androidPackage: string;
  version: string;
  /** The expected versionCode; null only on a dry run that could not know it. */
  versionCode: number | null;
  /** Where the expected versionCode comes from ("app.json", "the APK", …); absent in runs before 0.2.2. */
  versionCodeFrom?: string;
  installedVersionCode: number | null;
  apk: string;
  device: DeviceInfo;
  startedAt: string;
  /** Empty while the run is going on, or when it was killed. */
  finishedAt: string;
  /** The capture folder (absolute), for `--resume`. */
  outDir: string;
  /** e.g. "3 key screens × 2 modes × … = 32, in 8 batches" */
  plan: string;
  /** The device settings before the first run, restored at the end (kept by --resume). */
  saved: SavedSettings | null;
  smoke: FlowResult[];
  /** Every planned screenshot; those not run yet have neither file nor error. */
  shots: Shot[];
  notes: string[];
  /** Problems of the test bench itself (software rendering, a saturated emulator): shown on top. */
  warnings?: string[];
  migration?: MigrationRun;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Links to the copy of Maestro's debug folder (its log and screenshots). */
const debugLinks = (dir?: string) =>
  dir
    ? `<small class="debug"><a href="${esc(dir)}/" target="_blank">debug folder</a> · <a href="${esc(dir)}/maestro.log" target="_blank">maestro.log</a></small>`
    : '';

export const scaleLabel = (scale: number) => `${scale.toFixed(1)}×`;

/** The QA gallery: one self-contained page next to the PNGs. */
export function renderReport(r: QaRun): string {
  const smokeFailed = r.smoke.filter((f) => !f.ok).length;
  const shotsFailed = r.shots.filter((s) => !s.file).length;
  const notRun = r.shots.filter((s) => !s.file && !s.error).length;
  const screens = [...new Set(r.shots.map((s) => s.screen))];
  const values = (key: 'mode' | 'lang') => [...new Set(r.shots.map((s) => s[key]))];
  const scales = [...new Set(r.shots.map((s) => s.scale))];

  const flowRow = (f: FlowResult) =>
    `<tr class="${f.ok ? 'pass' : 'fail'}"><td>${f.ok ? 'PASS' : 'FAIL'}</td><td>${esc(f.flow)}</td>` +
    `<td>${f.seconds.toFixed(1)} s</td><td>${f.errorLine ? `<b>${esc(f.errorLine)}</b>` : ''}${debugLinks(f.debug)}` +
    `${f.error ? `<details><summary>Maestro output</summary><pre>${esc(f.error)}</pre></details>` : ''}</td></tr>`;
  const smokeRows = r.smoke.map(flowRow).join('\n');

  const m = r.migration;
  const migrationFailed = !!m && !(m.seed?.ok && m.verify?.ok);
  const migrationFlows = m ? [m.seed, m.verify].filter((f): f is FlowResult => !!f) : [];
  const migration = m
    ? `<h2>Migration from ${esc(m.from)}${m.fromVersionCode !== null ? ` (versionCode ${m.fromVersionCode})` : ''}</h2>\n` +
      (migrationFlows.length ? `<table>${migrationFlows.map(flowRow).join('\n')}</table>` : '<p class="meta">Not run.</p>')
    : '';
  const warnings = (r.warnings ?? []).map((w) => `<p class="incomplete warning">${esc(w)}</p>`).join('\n');

  const filter = (name: string, items: string[]) =>
    `<fieldset><legend>${name}</legend>${items
      .map((v) => `<label><input type="checkbox" data-filter="${esc(name)}" value="${esc(v)}" checked> ${esc(v)}</label>`)
      .join('')}</fieldset>`;

  const sections = screens
    .map((screen) => {
      const figures = r.shots
        .filter((s) => s.screen === screen)
        .map((s) => {
          const label = `${s.mode} · ${s.lang} · ${scaleLabel(s.scale)}`;
          const body = s.file
            ? `<a href="${esc(s.file)}" target="_blank"><img src="${esc(s.file)}" alt="${esc(`${screen} ${label}`)}" loading="lazy"></a>`
            : s.error
              ? `<div class="missing">No screenshot<br><small>${esc(s.error)}</small>${debugLinks(s.debug)}</div>`
              : '<div class="missing pending">Not captured<br><small>the run stopped before it</small></div>';
          return `<figure data-mode="${esc(s.mode)}" data-lang="${esc(s.lang)}" data-scale="${esc(scaleLabel(s.scale))}">${body}<figcaption>${esc(label)}</figcaption></figure>`;
        })
        .join('\n');
      return `<section><h2>${esc(screen)}</h2><div class="grid">${figures}</div></section>`;
    })
    .join('\n');

  const d = r.device;
  const vcOk = r.versionCode !== null && r.installedVersionCode === r.versionCode;
  const vcFrom = r.versionCodeFrom ? `, from ${esc(r.versionCodeFrom)}` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.appName)} ${esc(r.version)} QA</title>
<style>
:root { --bg: #f6f4f0; --fg: #1d1b18; --muted: #6b645c; --card: #fff; --line: #ddd5c8; --pass: #2f6b45; --fail: #a8432f; }
@media (prefers-color-scheme: dark) { :root { --bg: #161311; --fg: #eee6da; --muted: #a99d8f; --card: #221d19; --line: #3a3029; --pass: #8cc09e; --fail: #e8876f; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
h1 { margin: 0 0 4px; font-size: 22px; } h2 { margin: 28px 0 10px; font-size: 18px; }
.meta { color: var(--muted); margin: 0 0 12px; }
.summary span { display: inline-block; margin: 0 12px 6px 0; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--line); }
.bad { color: var(--fail); border-color: var(--fail) !important; } .good { color: var(--pass); border-color: var(--pass) !important; }
table { border-collapse: collapse; width: 100%; background: var(--card); }
td { border-top: 1px solid var(--line); padding: 6px 8px; vertical-align: top; }
tr.pass td:first-child { color: var(--pass); font-weight: 700; } tr.fail td:first-child { color: var(--fail); font-weight: 700; }
pre { margin: 0; white-space: pre-wrap; font-size: 12px; max-height: 12em; overflow: auto; }
.filters { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 0; background: var(--bg); }
fieldset { border: 1px solid var(--line); border-radius: 8px; padding: 2px 10px 6px; } legend { color: var(--muted); }
label { margin-right: 10px; white-space: nowrap; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; }
figure { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 6px; }
figure img { width: 100%; display: block; border-radius: 6px; }
figcaption { text-align: center; color: var(--muted); padding-top: 4px; font-size: 12px; }
.incomplete { border: 1px solid var(--fail); border-radius: 8px; padding: 8px 12px; color: var(--fail); }
.missing.pending { color: var(--muted); }
.warning { font-weight: 600; }
.missing { aspect-ratio: 9 / 19; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: var(--fail); padding: 8px; }
ul.notes { color: var(--muted); }
small.debug { display: block; margin-top: 4px; } a { color: inherit; }
details summary { cursor: pointer; color: var(--muted); }
</style>
</head>
<body>
<h1>${esc(r.appName)} ${esc(r.version)} <small>(versionCode ${r.versionCode ?? 'unknown'}${vcFrom})</small></h1>
<p class="meta">${esc(`${d.manufacturer} ${d.model}`.trim())} · Android ${esc(d.androidVersion)} (API ${d.sdk}) · ${esc(d.serial)}<br>
Installed versionCode: <b class="${vcOk ? 'good' : 'bad'}">${r.installedVersionCode ?? 'none'}</b> · APK: ${esc(r.apk)}<br>
${esc(r.startedAt)} → ${r.finishedAt ? esc(r.finishedAt) : '<b class="bad">not finished</b>'} · Plan: ${esc(r.plan)}</p>
${
  r.finishedAt && !notRun
    ? ''
    : `<p class="incomplete">Incomplete run: ${notRun} screenshot(s) not captured. Continue it with<br><code>mk qa:device --resume ${esc(r.outDir)}</code> (add <code>--emulator</code> for the emulator).</p>`
}
${warnings}
<p class="summary">
${m ? `<span class="${migrationFailed ? 'bad' : 'good'}">Migration: ${migrationFailed ? 'FAILED' : 'passed'}</span>\n` : ''}<span class="${smokeFailed ? 'bad' : 'good'}">Smoke: ${r.smoke.length - smokeFailed}/${r.smoke.length} passed</span>
<span class="${shotsFailed ? 'bad' : 'good'}">Screenshots: ${r.shots.length - shotsFailed}/${r.shots.length}</span>${
    notRun ? `
<span class="bad">Not captured: ${notRun}</span>` : ''
  }
</p>
${r.notes.length ? `<ul class="notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
${migration}
<h2>Maestro smoke flows</h2>
${r.smoke.length ? `<table>${smokeRows}</table>` : '<p class="meta">None run.</p>'}
<div class="filters">${filter('mode', values('mode'))}${filter('lang', values('lang'))}${filter('scale', scales.map(scaleLabel))}</div>
${sections}
<script>
document.addEventListener('change', () => {
  const on = (name) => [...document.querySelectorAll('input[data-filter="' + name + '"]:checked')].map((i) => i.value);
  const sel = { mode: on('mode'), lang: on('lang'), scale: on('scale') };
  document.querySelectorAll('figure').forEach((f) => {
    f.hidden = !(sel.mode.includes(f.dataset.mode) && sel.lang.includes(f.dataset.lang) && sel.scale.includes(f.dataset.scale));
  });
});
</script>
</body>
</html>
`;
}
