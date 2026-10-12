// What a failed `maestro test` printed, made readable for the report.
//
// Maestro ends a failure with its debug folder and a "Run your flows on
// Maestro Cloud" box. On a Windows console the box's frame turns into "?"
// characters, and the last lines of the output were nothing but that box.
// This keeps the real error: the step that FAILED and the line after it.

export interface MaestroOutput {
  /** The output without the box and the debug banner. */
  text: string;
  /** The folder Maestro printed under "==== Debug output", or null. */
  debugDir: string | null;
  /** e.g. "Tap on id: tab-shelves: Element not found: Id matching regex: tab-shelves" */
  errorLine: string | null;
}

const FRAME_START = /^[?│┃║╭╮╰╯┌┐└┘╔╗╚╝|]/;
const FRAME_END = /[?│┃║╭╮╰╯┌┐└┘╔╗╚╝─━═|]$/;
const DEBUG_BANNER = /^=+\s*Debug output/i;
const FAILED_STEP = /^(.*?)\s*(?:\.\.\.|…)\s*FAILED\s*$/;

/** A line of a drawn box (or its "?" remains): frame first and last. */
const isFrame = (line: string) => {
  const t = line.trim();
  return t !== '' && FRAME_START.test(t) && FRAME_END.test(t);
};

export function parseMaestroOutput(output: string): MaestroOutput {
  const lines = output.replace(/\r/g, '').split('\n');
  let debugDir: string | null = null;
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (DEBUG_BANNER.test(line.trim())) {
      // The folder is the next non-empty line.
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? '').trim() === '') j++;
      const candidate = (lines[j] ?? '').trim();
      if (/[\\/]/.test(candidate) && !isFrame(candidate)) {
        debugDir = candidate;
        i = j;
      }
      continue;
    }
    if (isFrame(line)) continue;
    kept.push(line);
  }
  while (kept.length && kept[kept.length - 1]?.trim() === '') kept.pop();
  const text = kept.join('\n').trim();

  let errorLine: string | null = null;
  for (let i = kept.length - 1; i >= 0 && !errorLine; i--) {
    const step = FAILED_STEP.exec((kept[i] ?? '').trim());
    if (!step) continue;
    const message = kept.slice(i + 1).find((l) => l.trim() !== '')?.trim();
    errorLine = message ? `${step[1]}: ${message}` : `${step[1]}: FAILED`;
  }
  if (!errorLine) errorLine = [...kept].reverse().find((l) => l.trim() !== '')?.trim() ?? null;
  return { text, debugDir, errorLine };
}
