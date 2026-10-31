// The computer running mk: memory, and processes a killed run left behind.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { act, run } from './exec.js';
import type { GuardState } from './guard.js';
import { warn } from './log.js';
import type { Project } from './project.js';

export interface HostMemory {
  freeMb: number;
  emulatorMb: number;
}

/** Free RAM and the emulator's memory, or null when it cannot be read. */
export function hostMemory(p: Project): HostMemory | null {
  const r = run(p.tool.procs, ['mem']);
  if (r.status !== 0) return null;
  try {
    const m = JSON.parse(r.stdout.trim()) as Partial<HostMemory>;
    return typeof m.freeMb === 'number' && typeof m.emulatorMb === 'number' ? { freeMb: m.freeMb, emulatorMb: m.emulatorMb } : null;
  } catch {
    return null;
  }
}

/** Why the emulator should be restarted, or null. */
export function memoryPressure(m: HostMemory, limits: { minFreeMb: number; maxEmulatorMb: number }): string | null {
  if (m.freeMb < limits.minFreeMb) return `free RAM ${m.freeMb} MB < ${limits.minFreeMb} MB`;
  if (m.emulatorMb > limits.maxEmulatorMb) return `emulator uses ${m.emulatorMb} MB > ${limits.maxEmulatorMb} MB`;
  return null;
}

/** Maestro runs on `serial` still alive (a run that was killed): how many were stopped. */
export function killLeftoverMaestro(p: Project, serial: string): number {
  return Number(act(p.dryRun, p.tool.procs, ['kill-maestro', serial]).stdout.trim()) || 0;
}

/** The AVD's emulator processes, when `adb emu kill` did not stop them. */
export function killEmulatorProcesses(p: Project, avd: string): number {
  return Number(act(p.dryRun, p.tool.procs, ['kill-emulator', avd]).stdout.trim()) || 0;
}

/** Every process mk started (Maestro, adb, the emulator), at once: a forced stop. */
export function killChildren(p: Project): number {
  return Number(act(p.dryRun, p.tool.procs, ['kill-tree', String(process.pid)]).stdout.trim()) || 0;
}

export interface Guard {
  /** The device changed (a restart) or mk now owns the emulator. */
  update(patch: Partial<Pick<GuardState, 'serial' | 'ownsEmulator'>>): void;
  /** The process that started mk is gone (the guard wrote the flag): stop now. */
  orphaned(): boolean;
  /** mk is done: the guard exits without touching anything. */
  stop(): void;
}

const NO_GUARD: Guard = { update: () => undefined, orphaned: () => false, stop: () => undefined };

/** Starts the guard (guard.ts) for this run; none on a dry run. */
export function startGuard(p: Project, initial: Pick<GuardState, 'serial' | 'ownsEmulator' | 'keepEmulator'>): Guard {
  if (p.dryRun) return NO_GUARD;
  const dir = process.env.MK_GUARD_DIR ?? os.tmpdir();
  const file = path.join(dir, `mk-guard-${process.pid}.json`);
  const state: GuardState = {
    mkPid: process.pid,
    mkStarted: Date.now() - Math.round(process.uptime() * 1000),
    avd: p.config.emulator.avd,
    adb: p.tool.adb,
    orphanFlag: path.join(dir, `mk-guard-${process.pid}.orphaned`),
    ...initial,
  };
  const write = () => fs.writeFileSync(file, JSON.stringify(state));
  try {
    fs.rmSync(state.orphanFlag, { force: true });
    write();
  } catch (e) {
    warn(`No guard for this run (cannot write ${file}: ${(e as Error).message}): if mk is killed, stop Maestro and the emulator by hand`);
    return NO_GUARD;
  }
  if (run(p.tool.procs, ['guard', file]).status !== 0) {
    fs.rmSync(file, { force: true });
    warn('No guard for this run (procs.js guard failed): if mk is killed, stop Maestro and the emulator by hand');
    return NO_GUARD;
  }
  return {
    update(patch) {
      Object.assign(state, patch);
      if (fs.existsSync(file)) write();
    },
    orphaned: () => fs.existsSync(state.orphanFlag),
    stop() {
      fs.rmSync(file, { force: true });
      fs.rmSync(state.orphanFlag, { force: true });
    },
  };
}
