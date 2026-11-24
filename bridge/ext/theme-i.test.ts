// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// theme-i: theme.set in a sch or pcb frame, its args read closed, the theme
// written under a fresh name and switched to through kicadSetColorTheme, null
// bringing the palette back, a burst coalesced to its newest set, and the op
// unsupported naming the export on an engine without it (the cap then not
// listed). The engine here is this test's own module of exports (at the
// protocol boundary); the real engine is the e2e's (tests/e2e/theme.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import type { Frame } from '../../src/types';
import { buildRegistry, REGISTRY } from './registry';
import unit, { ENGINE_PCBJAM, EVERY_FRAME_BUILDS, LIVE_STEM, MAX_THEME_BYTES, PALETTE_THEME, SCH_PCB_BUILDS, THEME_CAP, THEME_ENGINE, THEME_EXPORTS, parseThemeArgs, switchesIn, themeFileText, themeSet } from './theme-i';
import { SHEET_THEME, sheetThemeOf } from '../../theme/sheet-theme';
import paletteText from '../../theme/colors/circuitcenter.json?raw';
import pin from '../../PIN.json';

const T18B = '01c552e7a89beca3ebd9907707c0fb760b7c8ebe';
const T18C = '3e9e31697fd53a54992158bce242b3f94bce4a8e';
import { KEPT_KEY, KEPT_THEME } from '../../theme/kept';
import { seedsFor } from '../../theme/seeds';
import { KICAD_CONFIG_DIR } from '../../loader/src/wasm/constants';
import palette from '../../theme/colors/circuitcenter.json';

const PARENT = 'http://localhost';
const COLORS = `${KICAD_CONFIG_DIR}/colors`;
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const THEME = (bg: string) => ({ ...(palette as Record<string, Record<string, unknown>>), schematic: { ...(palette as { schematic: Record<string, unknown> }).schematic, background: bg } });

/** The island origin's localStorage, stubbed fresh for each test. */
let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
  vi.stubGlobal('KeyboardEvent', class extends Event {
    constructor(type: string, init: Record<string, unknown> = {}) {
      const { bubbles, cancelable, composed, ...rest } = init as EventInit & Record<string, unknown>;
      super(type, { bubbles, cancelable, composed });
      Object.assign(this, rest);
    }
  });
});
afterEach(() => { vi.unstubAllGlobals(); THEME_ENGINE.build = ENGINE_PCBJAM; });

function fakePage(search: string) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const parent = { postMessage: vi.fn() };
  const page = {
    parent,
    top: {},
    location: { search },
    addEventListener: (t: string, h: (e: unknown) => void) => { const s = listeners.get(t) ?? new Set(); s.add(h); listeners.set(t, s); },
    removeEventListener: (t: string, h: (e: unknown) => void) => listeners.get(t)?.delete(h),
    dispatch: (t: string, e: unknown) => { for (const h of listeners.get(t) ?? []) h(e); },
  };
  return { page: page as unknown as Window & { dispatch: (t: string, e: unknown) => void }, parent };
}

/** A fake MEMFS: the files written, removed and present. */
function fakeFs() {
  const files = new Map<string, string>();
  const log: string[] = [];
  return {
    files,
    log,
    fs: {
      mkdirTree: () => {},
      writeFile: (p: string, d: string) => { files.set(p, d); log.push(`write ${p}`); },
      analyzePath: (p: string) => ({ exists: files.has(p) }),
      unlink: (p: string) => { files.delete(p); log.push(`unlink ${p}`); },
      readdir: () => [],
      readFile: () => { throw new Error('ENOENT'); },
    },
  };
}

/** A responder with this unit alone, booted in `frame` on an engine with `exports`. */
async function boot(frame: string, exports: Record<string, unknown>, ready = true) {
  const reg = buildRegistry(mods(unit));
  expect(reg.problems).toEqual([]);
  const { page, parent } = fakePage(`?frame=${frame}&theme=day`);
  const r = startResponder({ parentOrigin: PARENT, page, ext: reg });
  const ch = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  ch.port1.onmessage = (m) => got.push(m.data);
  page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
  const f = fakeFs();
  const typeName = frame === 'pcb' ? 'PCB_EDIT_FRAME' : frame === 'symedit' ? 'SYMBOL_EDIT_FRAME' : 'SCH_EDIT_FRAME';
  const win = {
    FS: f.fs,
    Module: { kicadOpenFileBusy: () => false, ...exports },
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName, name: 'Frame', visible: true }], findByLabel: () => [] },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    dispatchEvent: () => true,
  } as unknown as ToolWindow;
  if (ready) r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  const ask = async (id: number, op: string, args?: unknown) => {
    ch.port1.postMessage(args === undefined ? { id, op } : { id, op, args });
    await settle(60);
    return got.find((m) => m.id === id);
  };
  return { r, got, files: f.files, ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, ask };
}

/** A ResponderCtx over a fake engine; `idle` answers applyIdle (a promise holds it). */
function fakeCtx(opts: { idle?: () => boolean | Promise<boolean>; busy?: string; missing?: string; inFlight?: () => number; ready?: boolean; switchThrows?: boolean; frame?: string; booted?: boolean } = {}) {
  const calls: string[] = [];
  const f = fakeFs();
  if (opts.booted) f.files.set(`${COLORS}/${KEPT_THEME}.json`, '{}');
  const mod: Record<string, unknown> = {
    kicadCollabBusy: () => false,
    kicadSetColorTheme: (name: string) => { calls.push(`switch ${name}`); if (opts.switchThrows) throw new Error('trap'); },
  };
  if (opts.missing != null) delete mod[opts.missing];
  const ctx = {
    frame: opts.frame ?? 'sch',
    timing: { themeMs: 200, applyPollMs: 5 },
    ready: () => opts.ready ?? true,
    closed: () => false,
    mod: () => mod,
    fs: () => f.fs,
    win: () => null,
    engineBusy: () => opts.busy === 'engine',
    importing: () => opts.busy === 'import',
    checking: () => opts.busy === 'check',
    keysBlocked: () => opts.busy === 'keys',
    inFlight: opts.inFlight ?? (() => 0),
    applyIdle: async () => { calls.push('idle'); return (opts.idle ?? (() => true))(); },
    withTimeout: async <T,>(v: T | Promise<T>) => v,
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, calls, files: f.files, fsLog: f.log };
}

describe('theme-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning theme.set and its cap, answered off the queue', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('theme.set')?.unit).toBe('theme-i');
    expect(REGISTRY.ops.get('theme.set')?.op.now).toBe(true);
    expect(REGISTRY.capNames.get(THEME_CAP)).toBe('theme-i');
    expect(THEME_CAP).toBe('theme');
    expect(THEME_EXPORTS).toEqual(['kicadSetColorTheme', 'kicadCollabBusy']);
  });

  it('brings back the palette the island seeds', () => {
    expect(seedsFor('day').colorTheme).toBe(PALETTE_THEME);
    expect(seedsFor('night').colorTheme).toBe(PALETTE_THEME);
  });

  it('lists theme in a sch and a pcb frame on engine build T18b, in every frame from T18c, and only on an engine with both exports', () => {
    const both = { kicadSetColorTheme: () => {}, kicadCollabBusy: () => false };
    for (const frame of ['sch', 'pcb']) {
      expect(switchesIn(both, frame, T18B)).toBe(true);
      expect(switchesIn(both, frame, T18C)).toBe(true);
    }
    for (const frame of ['symedit', 'fpedit', 'ds']) {
      expect(switchesIn(both, frame, T18B)).toBe(false);
      expect(switchesIn(both, frame, T18C)).toBe(true);
      // A build in neither list is taken as one that switches the schematic and board editors only.
      expect(switchesIn(both, frame, 'f00d')).toBe(false);
      expect(switchesIn(both, frame, '')).toBe(false);
    }
    expect(switchesIn({ kicadCollabBusy: () => false }, 'sch', T18C)).toBe(false);
    THEME_ENGINE.build = T18B;
    expect(unit.caps!(both, 'sch')).toEqual(['theme']);
    expect(unit.caps!(both, 'fpedit' as Frame)).toEqual([]);
    THEME_ENGINE.build = T18C;
    for (const frame of ['sch', 'pcb', 'symedit', 'fpedit', 'ds'] as Frame[]) expect(unit.caps!(both, frame)).toEqual(['theme']);
  });

  it('reads the build compiled in from PIN.json, which is in one of the two lists', () => {
    expect(ENGINE_PCBJAM).toBe((pin as { engine: { build?: { pcbjam?: string } } }).engine.build?.pcbjam ?? '');
    expect([...EVERY_FRAME_BUILDS, ...SCH_PCB_BUILDS]).toContain(ENGINE_PCBJAM);
    expect(EVERY_FRAME_BUILDS).toContain(T18C);
    expect(SCH_PCB_BUILDS).toContain(T18B);
  });
});

describe('theme.set, the args', () => {
  it('takes null, and a theme whose every section is an object', () => {
    expect(parseThemeArgs({ colors: null })).toBeNull();
    expect(parseThemeArgs({ colors: palette })).toEqual(palette);
    expect(parseThemeArgs({ colors: { schematic: { background: 'rgb(255, 255, 255)' } } })).toEqual({ schematic: { background: 'rgb(255, 255, 255)' } });
  });

  it('refuses anything else', () => {
    const bad: unknown[] = [
      undefined, null, {}, [], 'x', { colors: undefined }, { colors: null, x: 1 }, { colors: [] }, { colors: 'circuitcenter' }, { colors: {} },
      { colors: { schematic: 'red' } }, { colors: { schematic: null } }, { colors: { schematic: [1] } }, { colors: { schematic: { background: null } } },
      { colors: { schematic: { background: [255, 0, 0] } } }, { colors: { schematic: { background: Number.NaN } } },
      { colors: { schematic: { a: { b: { c: { d: 'x' } } } } } }, { colors: { '../x': {} } }, { colors: { schematic: { 'a b': 'x' } } },
      { colors: { schematic: { background: 'x'.repeat(257) } } },
      { colors: { schematic: Object.fromEntries(Array.from({ length: MAX_THEME_BYTES / 64 }, (_, i) => [`k${i}`, 'rgb(255, 255, 255)'.padEnd(60, ' ')])) } },
      { colors: Object.assign(Object.create({ evil: 1 }), { schematic: {} }) },
    ];
    for (const a of bad) expect(parseThemeArgs(a), JSON.stringify(a)?.slice(0, 80)).toBeUndefined();
  });

  it('gives a theme without meta the palette\'s version, and keeps a meta it names', () => {
    expect(JSON.parse(themeFileText({ schematic: { background: 'rgb(1, 2, 3)' } })).meta).toEqual({ name: 'Circuit Center host theme', version: 5 });
    expect(JSON.parse(themeFileText(palette as never)).meta).toEqual((palette as { meta: unknown }).meta);
    expect(JSON.parse(themeFileText(palette as never)).schematic).toEqual((palette as { schematic: unknown }).schematic);
  });
});

describe('theme.set, the op', () => {
  it('writes the theme under a fresh name, switches to it, waits for the apply queue, and answers {}', async () => {
    const f = fakeCtx();
    expect(await themeSet({ colors: THEME('rgb(255, 255, 255)') }, f.ctx)).toEqual({ ok: true, result: { ok: true } });
    expect(f.calls).toEqual([`switch ${LIVE_STEM}1`, 'idle']);
    expect(JSON.parse(f.files.get(`${COLORS}/${LIVE_STEM}1.json`)!).schematic.background).toBe('rgb(255, 255, 255)');
    // A second set takes a second name (the engine skips a switch to the name it holds), and the first file goes.
    expect(await themeSet({ colors: THEME('rgb(0, 0, 0)') }, f.ctx)).toEqual({ ok: true, result: { ok: true } });
    expect(f.calls.slice(2)).toEqual([`switch ${LIVE_STEM}2`, 'idle']);
    expect([...f.files.keys()]).toEqual([`${COLORS}/${LIVE_STEM}2.json`]);
  });

  it('null brings the palette back and removes the host\'s file; null while the palette shows changes nothing', async () => {
    const f = fakeCtx();
    expect(await themeSet({ colors: null }, f.ctx)).toEqual({ ok: true, result: { ok: true } });
    expect(f.calls).toEqual([]);
    await themeSet({ colors: THEME('rgb(255, 255, 255)') }, f.ctx);
    expect(await themeSet({ colors: null }, f.ctx)).toEqual({ ok: true, result: { ok: true } });
    expect(f.calls).toEqual([`switch ${LIVE_STEM}1`, 'idle', `switch ${PALETTE_THEME}`, 'idle']);
    expect(f.files.size).toBe(0);
    expect(await themeSet({ colors: null }, f.ctx)).toEqual({ ok: true, result: { ok: true } });
    expect(f.calls).toHaveLength(4);
  });

  it('applies a burst serially, only its newest set after the one running, and answers every set', async () => {
    let release!: (v: boolean) => void;
    let first = true;
    const f = fakeCtx({ idle: () => (first ? (first = false, new Promise<boolean>((r) => { release = r; })) : true) });
    const a = themeSet({ colors: THEME('rgb(1, 1, 1)') }, f.ctx);
    await settle();
    expect(f.calls).toEqual([`switch ${LIVE_STEM}1`, 'idle']);
    const rest = ['rgb(2, 2, 2)', 'rgb(3, 3, 3)', 'rgb(4, 4, 4)'].map((bg) => themeSet({ colors: THEME(bg) }, f.ctx));
    await settle();
    expect(f.calls).toHaveLength(2);
    release(true);
    expect(await Promise.all([a, ...rest])).toEqual(Array(4).fill({ ok: true, result: { ok: true } }));
    expect(f.calls).toEqual([`switch ${LIVE_STEM}1`, 'idle', `switch ${LIVE_STEM}2`, 'idle']);
    expect(JSON.parse(f.files.get(`${COLORS}/${LIVE_STEM}2.json`)!).schematic.background).toBe('rgb(4, 4, 4)');
  });

  it('a set behind a request on the queue waits for it, and answers busy when it stays past the time limit', async () => {
    let n = 1;
    const f = fakeCtx({ inFlight: () => n });
    const p = themeSet({ colors: THEME('rgb(9, 9, 9)') }, f.ctx);
    await settle(30);
    expect(f.calls).toEqual([]);
    n = 0;
    expect(await p).toEqual({ ok: true, result: { ok: true } });
    const stuck = fakeCtx({ inFlight: () => 1 });
    expect(await themeSet({ colors: THEME('rgb(9, 9, 9)') }, stuck.ctx)).toEqual({ ok: false, code: 'busy', message: 'theme.set' });
    expect(stuck.calls).toEqual([]);
  });

  it('answers busy while a load is parked, an import or a check runs, or a menu or dialog is up, calling nothing', async () => {
    for (const busy of ['engine', 'import', 'check', 'keys']) {
      const f = fakeCtx({ busy });
      expect(await themeSet({ colors: THEME('rgb(9, 9, 9)') }, f.ctx)).toEqual({ ok: false, code: 'busy', message: 'theme.set' });
      expect(f.calls).toEqual([]);
      expect(f.files.size).toBe(0);
    }
  });

  it('answers not_applied when the apply queue never empties, island_error when the switch throws, and keeps going', async () => {
    const f = fakeCtx({ idle: () => false });
    expect(await themeSet({ colors: THEME('rgb(9, 9, 9)') }, f.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'theme.set' });
    const t = fakeCtx({ switchThrows: true });
    expect(await themeSet({ colors: THEME('rgb(9, 9, 9)') }, t.ctx)).toEqual({ ok: false, code: 'island_error', message: 'trap' });
    expect(await themeSet({ colors: null }, t.ctx)).toEqual({ ok: true, result: { ok: true } });
  });

  it('reads the args and the engine before anything else', async () => {
    const f = fakeCtx();
    expect(await themeSet({ colors: 'red' }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'theme.set' });
    expect(await themeSet({ colors: null }, fakeCtx({ ready: false }).ctx)).toEqual({ ok: false, code: 'not_ready', message: 'theme.set' });
    expect(await themeSet({ colors: null }, fakeCtx({ missing: 'kicadSetColorTheme' }).ctx)).toEqual({ ok: false, code: 'unsupported', message: 'kicadSetColorTheme' });
    expect(f.calls).toEqual([]);
  });
});

describe('theme.set, the kept colors', () => {
  it('keeps the colors of a set that applied, and null forgets them', async () => {
    const f = fakeCtx();
    const white = THEME('rgb(255, 255, 255)');
    await themeSet({ colors: white }, f.ctx);
    expect(JSON.parse(store.get(KEPT_KEY)!)).toEqual(white);
    await themeSet({ colors: null }, f.ctx);
    expect(store.has(KEPT_KEY)).toBe(false);
  });

  it('keeps nothing for a set that did not apply', async () => {
    const f = fakeCtx({ idle: () => false });
    await themeSet({ colors: THEME('rgb(1, 1, 1)') }, f.ctx);
    expect(store.has(KEPT_KEY)).toBe(false);
    const b = fakeCtx({ busy: 'keys' });
    await themeSet({ colors: THEME('rgb(1, 1, 1)') }, b.ctx);
    expect(store.has(KEPT_KEY)).toBe(false);
  });

  it('null with nothing applied changes nothing in the engine and still forgets stale kept colors', async () => {
    store.set(KEPT_KEY, JSON.stringify(THEME('rgb(7, 7, 7)')));
    const f = fakeCtx();
    expect(await themeSet({ colors: null }, f.ctx)).toEqual({ ok: true, result: { ok: true } });
    expect(f.calls).toEqual([]);
    expect(store.has(KEPT_KEY)).toBe(false);
  });

  it('a frame that booted in the kept theme switches back to the palette on null, and its kept file goes with the next set', async () => {
    const f = fakeCtx({ booted: true });
    expect(await themeSet({ colors: null }, f.ctx)).toEqual({ ok: true, result: { ok: true } });
    expect(f.calls).toEqual([`switch ${PALETTE_THEME}`, 'idle']);
    expect(f.files.has(`${COLORS}/${KEPT_THEME}.json`)).toBe(false);
    const g = fakeCtx({ booted: true });
    await themeSet({ colors: THEME('rgb(2, 2, 2)') }, g.ctx);
    expect([...g.files.keys()]).toEqual([`${COLORS}/${LIVE_STEM}1.json`]);
  });

  it('answers theme_frame where the engine does not switch (build T18b), keeping nothing', async () => {
    THEME_ENGINE.build = T18B;
    for (const frame of ['symedit', 'fpedit', 'ds']) {
      const f = fakeCtx({ frame });
      expect(await themeSet({ colors: THEME('rgb(1, 1, 1)') }, f.ctx)).toEqual({ ok: false, code: 'theme_frame', message: `the canvas colors of a ${frame} frame change at its next boot` });
      expect(f.calls).toEqual([]);
      expect(store.has(KEPT_KEY)).toBe(false);
    }
  });
});

describe('theme.set in a drawing sheet editor frame (build T18c)', () => {
  it('lays the sheet color over the colors received, and null brings back the sheet theme over the palette under a fresh name', async () => {
    THEME_ENGINE.build = T18C;
    const f = fakeCtx({ frame: 'ds' });
    const white = THEME('rgb(255, 255, 255)');
    expect(await themeSet({ colors: white }, f.ctx)).toEqual({ ok: true, result: { ok: true } });
    expect(f.calls).toEqual([`switch ${LIVE_STEM}1`, 'idle']);
    expect(f.files.get(`${COLORS}/${LIVE_STEM}1.json`)).toBe(sheetThemeOf(themeFileText(white)));
    expect(await themeSet({ colors: null }, f.ctx)).toEqual({ ok: true, result: { ok: true } });
    expect(f.calls.slice(2)).toEqual([`switch ${LIVE_STEM}2`, 'idle']);
    expect([...f.files.keys()]).toEqual([`${COLORS}/${LIVE_STEM}2.json`]);
    expect(f.files.get(`${COLORS}/${LIVE_STEM}2.json`)).toBe(sheetThemeOf(paletteText));
    // The sheet palette shows: null again changes nothing.
    expect(await themeSet({ colors: null }, f.ctx)).toEqual({ ok: true, result: { ok: true } });
    expect(f.calls).toHaveLength(4);
  });

  it('a ds frame that booted in the kept colors (under the seeded sheet theme name) switches to the sheet palette on null, never to that name', async () => {
    THEME_ENGINE.build = T18C;
    const f = fakeCtx({ frame: 'ds', booted: true });
    expect(await themeSet({ colors: null }, f.ctx)).toEqual({ ok: true, result: { ok: true } });
    expect(f.calls).toEqual([`switch ${LIVE_STEM}1`, 'idle']);
    expect(f.calls).not.toContain(`switch ${SHEET_THEME}`);
    // The kept file the boot seeded is not the frame's: it stays.
    expect(f.files.has(`${COLORS}/${KEPT_THEME}.json`)).toBe(true);
  });

  it('the symbol and footprint editors take a set and null as the schematic does', async () => {
    THEME_ENGINE.build = T18C;
    for (const frame of ['symedit', 'fpedit']) {
      const f = fakeCtx({ frame });
      expect(await themeSet({ colors: THEME('rgb(255, 255, 255)') }, f.ctx)).toEqual({ ok: true, result: { ok: true } });
      expect(await themeSet({ colors: null }, f.ctx)).toEqual({ ok: true, result: { ok: true } });
      expect(f.calls).toEqual([`switch ${LIVE_STEM}1`, 'idle', `switch ${PALETTE_THEME}`, 'idle']);
    }
  });
});

describe('theme.set through the responder', () => {
  const ENGINE = { kicadCollabBusy: () => false, kicadSetColorTheme: () => {} };

  it('lists the cap and answers a set in a sch and a pcb frame, with no document open', async () => {
    for (const frame of ['sch', 'pcb']) {
      const sw = vi.fn();
      const t = await boot(frame, { ...ENGINE, kicadSetColorTheme: sw });
      try {
        expect(t.ready?.caps).toContain('theme');
        expect(await t.ask(1, 'theme.set', { colors: THEME('rgb(255, 255, 255)') })).toEqual({ id: 1, ok: true, result: { ok: true } });
        expect(sw).toHaveBeenCalledWith(`${LIVE_STEM}1`);
        expect(await t.ask(2, 'theme.set', { colors: 1 })).toEqual({ id: 2, ok: false, error: { code: 'bad_args', message: 'theme.set' } });
      } finally { t.r.close(); }
    }
  });

  it('on an engine without the export: no cap, unsupported naming it', async () => {
    const t = await boot('sch', { kicadCollabBusy: () => false });
    try {
      expect(t.ready?.caps).not.toContain('theme');
      expect(await t.ask(1, 'theme.set', { colors: null })).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: 'kicadSetColorTheme' } });
    } finally { t.r.close(); }
  });

  it('before ev.ready it answers not_ready, and in a symedit frame theme_frame on build T18b', async () => {
    THEME_ENGINE.build = T18B;
    const early = await boot('sch', ENGINE, false);
    try {
      expect(await early.ask(1, 'theme.set', { colors: null })).toEqual({ id: 1, ok: false, error: { code: 'not_ready', message: 'theme.set' } });
    } finally { early.r.close(); }
    const sym = await boot('symedit', ENGINE);
    try {
      expect(sym.ready?.caps ?? []).not.toContain('theme');
      expect(await sym.ask(1, 'theme.set', { colors: null })).toEqual({ id: 1, ok: false, error: { code: 'theme_frame', message: 'the canvas colors of a symedit frame change at its next boot' } });
    } finally { sym.r.close(); }
  });
});
