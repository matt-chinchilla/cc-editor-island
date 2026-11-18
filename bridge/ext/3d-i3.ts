// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The 3D outputs' part in project.export (3D exports spec 8.3): no new op. A
// pcb_export_3d or pcb_render run gets its own time bound (exportMsFor), the
// bodies its board's model lines name staged before it runs
// (bridge/occModels.ts), `cc_occ: false` when the 3D service is not listed,
// and ev.export { job, phase, percent } at most every 250 ms while it goes:
// loading while the 3D service's files load, models while the bodies are
// staged, running from the render's "Rendering <n> percent" lines. The job
// pcb_render joins project.export under the cap render (pcb_render in the
// engine's kicadOutputJobs, engine run 15). KiCad's STEP and VRML exports and
// its 3D viewer's image actions are held: the host's Outputs page opens in
// their place.
import { EXPORT_LINES, exportMsFor, renderPercent } from '../export';
import { boardModelRefs, MAX_STAGED_BYTES, MAX_STAGED_FILES, noteOccLoading, occLoadingPercent, stageBoardModels, stageModels, type StageReport } from '../occModels';
import { hasAll, isObj, type ExportHooks, type ExportRun, type ExtUnit, type ResponderCtx } from './contract';

export const UNIT = '3d-i3';
/** The jobs this unit times, stages and reports. */
export const THREE_D_JOBS: readonly string[] = ['pcb_export_3d', 'pcb_render'];
/** The cap of pcb_render, and the 3D service's (3d-i1). */
export const RENDER_CAP = 'render';
export const OCC_CAP = 'occ';
/** ev.export goes out at most this often per run. */
export const PROGRESS_MS = 250;
export type ExportPhase = 'loading' | 'models' | 'running';

/** Whether the engine runs pcb_render: kicadOutputJobs() lists it among the board's jobs. */
export function renderListed(mod: Record<string, unknown>): boolean {
  if (!hasAll(mod, ['kicadOutputJobs'])) return false;
  let jobs: unknown;
  try { jobs = JSON.parse(String((mod.kicadOutputJobs as () => unknown)())); } catch { return false; }
  return isObj(jobs) && isObj(jobs.board) && Object.prototype.hasOwnProperty.call(jobs.board, 'pcb_render');
}

/**
 * Whether the engine's pcb_export_3d takes the key cc_occ (engine run 15,
 * P3D-2: kicadOutputJobs() lists it among the job's keys). An engine without
 * it would drop the key and name it in the answer, so it is sent only then.
 */
export function occFlagKnown(mod: Record<string, unknown> | null): boolean {
  if (mod == null || !hasAll(mod, ['kicadOutputJobs'])) return false;
  let jobs: unknown;
  try { jobs = JSON.parse(String((mod.kicadOutputJobs as () => unknown)())); } catch { return false; }
  return isObj(jobs) && isObj(jobs.board) && isObj(jobs.board.pcb_export_3d) && Object.prototype.hasOwnProperty.call(jobs.board.pcb_export_3d, 'cc_occ');
}

/**
 * One run's ev.export: an event is sent at once when PROGRESS_MS have passed
 * since the last one, else held and sent by the next flush whose turn has
 * come (the latest held one wins); the same phase and percent again is not sent.
 */
export class ExportProgress {
  private last = -Infinity;
  private lastKey = '';
  private held: { phase: ExportPhase; percent: number | null } | null = null;
  constructor(private readonly job: string, private readonly send: (payload: Record<string, unknown>) => void, private readonly now: () => number) {}

  push(phase: ExportPhase, percent: number | null): void {
    const key = `${phase}:${percent ?? ''}`;
    if (key === this.lastKey) { this.held = null; return; }
    if (this.now() - this.last < PROGRESS_MS) { this.held = { phase, percent }; return; }
    this.out(phase, percent, key);
  }

  flush(): void {
    const h = this.held;
    if (h == null || this.now() - this.last < PROGRESS_MS) return;
    this.held = null;
    this.out(h.phase, h.percent, `${h.phase}:${h.percent ?? ''}`);
  }

  private out(phase: ExportPhase, percent: number | null, key: string): void {
    this.last = this.now();
    this.lastKey = key;
    this.held = null;
    this.send(percent == null ? { job: this.job, phase } : { job: this.job, phase, percent });
  }
}

export interface HookDeps {
  /** The model store's ensure (3d-i2), null while this island has none. */
  ensure: () => ((ref: string) => Promise<string | null>) | null;
  /** The 3D service's loading percent (bridge/occModels.ts). */
  loading: () => number | null;
  now: () => number;
}

/** The model store's ensure (3d-i2), found by glob: absent on an island without the model store. */
const MODEL_STORE = import.meta.glob<{ ensureModel?: unknown }>('../../loader/src/wasm/libs/model-store.ts', { eager: true });
function ensureOfStore(): ((ref: string) => Promise<string | null>) | null {
  const mod = Object.values(MODEL_STORE)[0];
  return mod != null && typeof mod.ensureModel === 'function' ? (mod.ensureModel as (ref: string) => Promise<string | null>) : null;
}

/** What this unit reads of the 3D service's handle (src/occ-service.ts, 3d-i1). */
export interface OccHandleView {
  onProgress(fn: (loaded: number, total: number) => void): () => void;
  setStage(fn: ((input: { board: Uint8Array }) => Promise<{ models: Array<{ path: string; bytes: Uint8Array }>; report?: string }>) | null): void;
}

/** The 3D service's handle (3d-i1), found by glob: absent on an island without the 3D service. */
const OCC_SERVICE = import.meta.glob<{ occService?: unknown }>('../../src/occ-service.ts', { eager: true });
function occHandle(): OccHandleView | null {
  const mod = Object.values(OCC_SERVICE)[0];
  if (mod == null || typeof mod.occService !== 'function') return null;
  const h = (mod.occService as () => unknown)();
  return h != null && typeof (h as OccHandleView).onProgress === 'function' && typeof (h as OccHandleView).setStage === 'function' ? (h as OccHandleView) : null;
}

/** The line a 3D export's report gains for the bodies past the bounds, null when none. */
export function stageNote(report: StageReport): string | null {
  if (report.skipped.length === 0) return null;
  const shown = report.skipped.slice(0, 8).join(', ');
  return `${report.skipped.length} parts' bodies went past the bounds of ${MAX_STAGED_FILES.toLocaleString('en-US')} files and ${MAX_STAGED_BYTES / (1024 * 1024)} MiB and are not in the file: ${shown}${report.skipped.length > 8 ? ', ...' : ''}.`;
}

/**
 * At engineReady in a pcb frame: the 3D service's export stages its board's
 * bodies here (the board text the engine's STEP stub sends), and its loading
 * progress feeds ev.export's loading phase. The stop undoes both.
 */
export function installOcc(ctx: ResponderCtx, handle: OccHandleView | null, ensure: HookDeps['ensure']): (() => void) | undefined {
  if (ctx.frame !== 'pcb' || handle == null) return undefined;
  handle.setStage(async ({ board }) => {
    const fs = ctx.fs();
    const opened = ctx.opened();
    if (fs == null) return { models: [] };
    const projectDir = opened != null && opened.includes('/') ? opened.slice(0, opened.lastIndexOf('/')) : ctx.root;
    const { models, report } = await stageBoardModels(new TextDecoder().decode(board), { fs, projectDir, ensure: ensure() });
    const note = stageNote(report);
    return note == null ? { models } : { models, report: note };
  });
  const off = handle.onProgress((loaded, total) => noteOccLoading(loaded, total));
  return () => { off(); handle.setStage(null); noteOccLoading(0, 0); };
}

const pct = (done: number, total: number): number => (total > 0 ? Math.max(0, Math.min(100, Math.floor((done / total) * 100))) : 100);

/** The export hooks, their sources given (the tests give their own). */
export function exportHooksOf(deps: HookDeps): ExportHooks {
  const runs = new Map<number, ExportProgress>();
  const progressOf = (run: ExportRun, ctx: ResponderCtx): ExportProgress => {
    let p = runs.get(run.run);
    if (p == null) {
      p = new ExportProgress(run.job, (payload) => { if (!ctx.closed()) ctx.emitExt('ev.export', payload); }, deps.now);
      runs.set(run.run, p);
    }
    return p;
  };
  return {
    msFor: (job) => (THREE_D_JOBS.includes(job) ? exportMsFor(job) : null),

    async before(run, ctx) {
      if (!THREE_D_JOBS.includes(run.job)) return null;
      const progress = progressOf(run, ctx);
      const fs = ctx.fs();
      const board = ctx.opened();
      if (fs != null && board != null && board.endsWith('.kicad_pcb')) {
        const bytes = ctx.readBytes(board);
        if (bytes != null) {
          try {
            const report = await stageModels(boardModelRefs(new TextDecoder().decode(bytes)), {
              fs,
              projectDir: board.slice(0, board.lastIndexOf('/')) || ctx.root,
              ensure: deps.ensure(),
              onFile: (done, total) => progress.push('models', pct(done, total)),
            });
            if (report.skipped.length > 0 || report.missing.length > 0) ctx.log('[3d-i3]', `${report.staged.length} staged`, `${report.skipped.length} past the bounds`, `${report.missing.length} not found`);
          } catch (err) {
            ctx.log('[3d-i3]', 'staging', err instanceof Error ? err.message : String(err));
          }
        }
      }
      if (run.job === 'pcb_export_3d' && !ctx.caps().includes(OCC_CAP) && occFlagKnown(ctx.mod())) return { settings: { ...run.settings, cc_occ: false } };
      return null;
    },

    tick(run, ctx) {
      if (!THREE_D_JOBS.includes(run.job)) return;
      const progress = progressOf(run, ctx);
      const loading = deps.loading();
      if (loading != null) progress.push('loading', loading);
      if (run.job === 'pcb_render') {
        const lines = ctx.readBytes(`${run.dir}/${EXPORT_LINES}`);
        const percent = lines == null ? null : renderPercent(new TextDecoder().decode(lines));
        if (percent != null) progress.push('running', percent);
      }
      progress.flush();
    },

    after(run) {
      runs.delete(run.run);
    },
  };
}

export default {
  unit: UNIT,
  capNames: [RENDER_CAP],
  caps: (mod, frame) => (frame === 'pcb' && renderListed(mod) ? [RENDER_CAP] : []),
  events: { 'ev.export': ['job', 'phase', 'percent'] },
  exportJobs: { pcb_render: 'pcb' },
  held: ['pcbnew.EditorControl.exportSTEP', 'pcbnew.EditorControl.exportVRML', '3DViewer.Control.exportImage', '3DViewer.Control.copyToClipboard'],
  heldRows: [
    // The board's File > Export > STEP and VRML: the host's Outputs page opens on 3D model for CAD and on VRML.
    { action: 'pcbnew.EditorControl.exportSTEP', frames: ['pcb'], cap: 'export' },
    { action: 'pcbnew.EditorControl.exportVRML', frames: ['pcb'], cap: 'export' },
    // KiCad's 3D viewer's Export Image and Copy 3D image: held with no door (its frame never opens, show3DViewer being held).
    { action: '3DViewer.Control.exportImage', frames: ['pcb'], cap: 'heldKeys' },
    { action: '3DViewer.Control.copyToClipboard', frames: ['pcb'], cap: 'heldKeys' },
  ],
  exportHooks: exportHooksOf({ ensure: ensureOfStore, loading: occLoadingPercent, now: () => Date.now() }),
  install: (ctx) => installOcc(ctx, occHandle(), ensureOfStore),
} satisfies ExtUnit;

