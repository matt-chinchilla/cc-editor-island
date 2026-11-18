// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m1-i: our context menu. The engine here is this test's own module of exports
// and a small document; the real engine is the e2e's
// (tests/e2e/m/m1-menu.spec.ts, tests/e2e/m/m1-doors.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { dismissPopups, keysBlocked } from '../modal';
import { HELD_ACTIONS } from '../held';
import type { ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, { CONTEXT_MENU_CAP, cssPoint, MARKER_ATTR, MENU_EXPORTS, SHOW_CONTEXT_MENU } from './m1-i';
import { buildItems, collapse, readEngineMenu, type EngineItem, type MenuItem } from './m1-i/menu';
import { doorOf, PROMPTS_CAP } from './m1-i/doors';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.stubGlobal('KeyboardEvent', class extends Event {
    constructor(type: string, init: Record<string, unknown> = {}) {
      const { bubbles, cancelable, composed, ...rest } = init as EventInit & Record<string, unknown>;
      super(type, { bubbles, cancelable, composed });
      Object.assign(this, rest);
    }
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

/** A document with a body, createElement and a class querySelector: enough for the marker and bridge/modal.ts. */
function fakeDoc() {
  type El = { className: string; hidden: boolean; attrs: Record<string, string>; on: Map<string, Array<(e: Event) => void>>; setAttribute(n: string, v: string): void; addEventListener(t: string, f: (e: Event) => void): void; dispatchEvent(e: Event): boolean; remove(): void };
  const children: El[] = [];
  const doc = {
    children,
    body: { appendChild: (el: El) => { children.push(el); return el; } },
    createElement: (): El => {
      const el: El = {
        className: '', hidden: false, attrs: {}, on: new Map(),
        setAttribute(n, v) { this.attrs[n] = v; },
        addEventListener(t, f) { const l = this.on.get(t) ?? []; l.push(f); this.on.set(t, l); },
        dispatchEvent(e) { for (const f of this.on.get(e.type) ?? []) f(e); return true; },
        remove() { const i = children.indexOf(this); if (i >= 0) children.splice(i, 1); },
      };
      return el;
    },
    querySelector: (sel: string) => (sel.startsWith('.') ? children.find((c) => c.className.split(' ').includes(sel.slice(1))) ?? null : null),
    querySelectorAll: () => [],
  };
  return doc;
}

/** A frame window: its listeners, a dispatch, a document and the engine module. */
function fakeWin(mod: Record<string, unknown>) {
  const on = new Map<string, Array<(e: Event) => void>>();
  const document = fakeDoc();
  const w = {
    Module: mod,
    document,
    addEventListener: (t: string, f: (e: Event) => void) => { const l = on.get(t) ?? []; l.push(f); on.set(t, l); },
    removeEventListener: (t: string, f: (e: Event) => void) => { on.set(t, (on.get(t) ?? []).filter((g) => g !== f)); },
    fire: (e: Event) => { for (const f of on.get(e.type) ?? []) f(e); return e; },
    listeners: on,
    kicadHostMenu: undefined as { onMenu?: (json: unknown) => boolean } | undefined,
  };
  return w;
}

const RUN15 = (over: Record<string, unknown> = {}) => ({
  kicadHostContextMenu: () => true,
  kicadContextMenuChoose: vi.fn(() => 0),
  kicadContextMenuHighlight: vi.fn(() => 0),
  kicadRunAction: vi.fn(() => 0),
  ...over,
});

/** A ctx over a fake window, as the responder builds one; `state` steers what it reads. */
function fakeCtx(frame: string, mod: Record<string, unknown>, state: Partial<{ caps: string[]; doc: boolean; importing: boolean; ready: boolean; closed: boolean; busy: boolean; hanging: boolean }> = {}) {
  const w = fakeWin(mod);
  const s = { caps: [CONTEXT_MENU_CAP, 'heldKeys'], doc: true, importing: false, ready: true, closed: false, busy: false, hanging: false, ...state };
  const emitted: Array<{ type: string } & Record<string, unknown>> = [];
  let held = 0;
  const ctx = {
    frame, root: '/p', timing: {},
    win: () => w, mod: () => w.Module, fs: () => null, has: (n: readonly string[]) => n.every((x) => typeof w.Module[x] === 'function'),
    ready: () => s.ready, closed: () => s.closed, caps: () => s.caps,
    opened: () => (s.doc ? 'x.kicad_sch' : null), staged: () => null, hasDocument: () => s.doc, admit: () => s.doc,
    engineBusy: () => s.busy, keysBlocked: () => keysBlocked(w as never), placeHanging: () => s.hanging, importing: () => s.importing,
    checking: () => false, simRun: () => null, heldRows: () => heldActions(), readAsk: () => null, inFlight: () => 0,
    holdMenus: (on: boolean) => { held = Math.max(0, held + (on ? 1 : -1)); },
    emitExt: (type: string, payload: Record<string, unknown>) => { emitted.push({ type, ...payload }); },
    emit: (ev: { type: string }) => { emitted.push(ev); },
    log: () => {},
  } as unknown as ResponderCtx;
  const stop = unit.install!(ctx) as () => void;
  return { ctx, w, s, emitted, stop, held: () => held };
}

const item = (o: Partial<EngineItem>): EngineItem => ({ id: 1, kind: 'normal', label: 'x', enabled: true, checked: false, action: '', key: '', ...o });
const MENU = (token: number, items: EngineItem[], over: Record<string, unknown> = {}) =>
  JSON.stringify({ token, clarify: false, tool: 'eeschema.InteractiveSelection', title: '', at: { x: 10, y: 20 }, kinds: ['symbol'], items, ...over });
const SCH_MENU = (token = 7) => MENU(token, [
  item({ id: 101, label: 'Rotate Counterclockwise', action: 'eeschema.InteractiveEdit.rotateCCW', key: 'R' }),
  item({ id: 0, kind: 'separator', label: '' }),
  item({ id: 0, kind: 'separator', label: '' }),
  item({ id: 102, label: 'Change Symbol...', action: 'eeschema.InteractiveEdit.changeSymbol' }),
  item({ id: 103, kind: 'submenu', label: 'Symbol Unit', items: [item({ id: 104, label: 'Unit A', kind: 'radio', checked: true }), item({ id: 105, label: 'Unit B', kind: 'radio' })] }),
  item({ id: 106, label: 'Properties...', action: 'eeschema.InteractiveEdit.properties', enabled: false }),
  item({ id: 0, kind: 'separator', label: '' }),
]);
const contextMenus = (e: Array<{ type: string }>) => e.filter((m) => m.type === 'ev.contextMenu') as Array<Record<string, unknown>>;
const ends = (e: Array<{ type: string }>) => e.filter((m) => m.type === 'ev.contextMenuEnd');

describe('the unit in the registry', () => {
  it('loads in this checkout with nothing broken: its ops, cap and events its own', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.capNames.get(CONTEXT_MENU_CAP)).toBe('m1-i');
    for (const op of ['contextMenu.choose', 'contextMenu.highlight', 'action.run']) expect(REGISTRY.ops.get(op)?.unit).toBe('m1-i');
    expect(REGISTRY.ops.get('contextMenu.choose')?.op.now).toBe(true);
    expect(REGISTRY.ops.get('contextMenu.highlight')?.op.now).toBe(true);
    expect(REGISTRY.ops.get('action.run')?.op.now).toBeUndefined();
    expect(REGISTRY.events.get('ev.contextMenu')?.keys).toEqual(['token', 'clarify', 'frame', 'at', 'title', 'kinds', 'items', 'omitted']);
    expect(REGISTRY.events.get('ev.contextMenuEnd')?.keys).toEqual(['token', 'reason']);
    expect(REGISTRY.pending.has('action.run')).toBe(false);
  });

  it('holds nothing of its own (the doors table reads the union)', () => {
    expect((unit as ExtUnit).held ?? []).toEqual([]);
    expect((unit as ExtUnit).heldRows ?? []).toEqual([]);
  });
});

describe('contextMenu, feature detected', () => {
  it('lists the cap in every editor frame only with all four exports', () => {
    const caps = unit.caps!;
    for (const f of ['sch', 'pcb', 'symedit', 'fpedit', 'ds']) expect(caps(RUN15(), f as never)).toEqual([CONTEXT_MENU_CAP]);
    for (const name of MENU_EXPORTS) {
      const mod: Record<string, unknown> = RUN15();
      delete mod[name];
      expect(caps(mod, 'sch')).toEqual([]);
    }
    expect(caps({}, 'pcb')).toEqual([]);
    expect(caps(RUN15(), 'calculator' as never)).toEqual([]);
  });

  it('ev.ready lists contextMenu on a run 15 engine and not on run 14; the slot is set either way', async () => {
    const boot = async (exports: Record<string, unknown>) => {
      // The frames this unit names are defined by their own units (fp-i1, ds-i1) or still pending.
      const definers = REGISTRY.units.filter((u) => u.defineFrames != null && u.unit !== 'm1-i');
      const reg = buildRegistry(Object.fromEntries([...definers, unit].map((u) => [`./${u.unit}.ts`, { default: u }])), {}, Object.fromEntries(REGISTRY.pendingFrames));
      expect(reg.problems).toEqual([]);
      const listeners = new Map<string, Set<(e: unknown) => void>>();
      const parent = { postMessage: vi.fn() };
      const page = {
        parent, top: {}, location: { search: '?frame=sch&theme=day' },
        addEventListener: (t: string, h: (e: unknown) => void) => { const s = listeners.get(t) ?? new Set(); s.add(h); listeners.set(t, s); },
        removeEventListener: (t: string, h: (e: unknown) => void) => listeners.get(t)?.delete(h),
      };
      const r = startResponder({ parentOrigin: PARENT, page: page as unknown as Window, ext: reg });
      const ch = new MessageChannel();
      const got: Array<Record<string, unknown>> = [];
      ch.port1.onmessage = (m) => got.push(m.data);
      for (const h of listeners.get('message') ?? []) h({ origin: PARENT, source: parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
      const win = {
        FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
        Module: { kicadOpenFileBusy: () => false, ...exports },
        wxElementRegistry: { findAll: () => [], findByLabel: () => [] },
        document: { querySelector: () => null, querySelectorAll: () => [] },
        dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {},
      } as unknown as ToolWindow & { kicadHostMenu?: { onMenu?: unknown } };
      r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
      await settle();
      ch.port1.postMessage({ id: 1, op: 'action.run', args: { name: 'common.Control.zoomFitScreen' } });
      await settle();
      return { ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] }, run: got.find((m) => m.id === 1), win };
    };
    const t15 = await boot(RUN15());
    expect(t15.ready.caps).toContain(CONTEXT_MENU_CAP);
    expect(typeof t15.win.kicadHostMenu?.onMenu).toBe('function');
    // No document is open: the engine is never asked.
    expect(t15.run).toEqual({ id: 1, ok: false, error: { code: 'not_ready', message: 'action.run' } });
    const t14 = await boot({ kicadHostActions: () => true });
    expect(t14.ready.caps).not.toContain(CONTEXT_MENU_CAP);
    expect(t14.run).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: 'kicadRunAction' } });
  });
});

describe('the engine\'s menu read closed', () => {
  it('reads the model, sorting kinds and keeping cut', () => {
    const m = readEngineMenu(MENU(3, [item({ id: 5 })], { kinds: ['wire', 'label'], cut: true }));
    expect(m).toEqual({ token: 3, clarify: false, tool: 'eeschema.InteractiveSelection', title: '', at: { x: 10, y: 20 }, kinds: ['label', 'wire'], items: [item({ id: 5 })], cut: true });
  });

  it('refuses any other shape, so KiCad\'s own popup shows', () => {
    expect(readEngineMenu('{')).toBeNull();
    expect(readEngineMenu({})).toBeNull();
    expect(readEngineMenu(MENU(3, [item({})], { extra: 1 }))).toBeNull();
    expect(readEngineMenu(MENU(3, [{ ...item({}), extra: 1 } as EngineItem]))).toBeNull();
    expect(readEngineMenu(MENU(3, [item({ label: 'x'.repeat(129) })]))).toBeNull();
    expect(readEngineMenu(MENU(3, [item({ action: 'not an action' })]))).toBeNull();
    expect(readEngineMenu(MENU(3, [item({ id: -1 })]))).toBeNull();
    expect(readEngineMenu(MENU(3, [item({ kind: 'bogus' as never })]))).toBeNull();
    expect(readEngineMenu(MENU(3, [item({ items: [] })]))).toBeNull();
    expect(readEngineMenu(MENU(3, [item({})], { cut: false }))).toBeNull();
    expect(readEngineMenu(MENU(3, [item({})], { at: { x: 'a', y: 1 } }))).toBeNull();
    const deep = (d: number): EngineItem => (d === 0 ? item({ id: 9 }) : item({ id: 10 + d, kind: 'submenu', items: [deep(d - 1)] }));
    expect(readEngineMenu(MENU(3, [deep(2)]))).not.toBeNull();
    expect(readEngineMenu(MENU(3, [deep(3)]))).toBeNull();
    expect(readEngineMenu(MENU(3, Array.from({ length: 400 }, (_, i) => item({ id: i + 1 }))))).not.toBeNull();
    expect(readEngineMenu(MENU(3, Array.from({ length: 401 }, (_, i) => item({ id: i + 1 }))))).toBeNull();
  });
});

describe('the items of ev.contextMenu', () => {
  const doors = (a: string) => (a === 'x.y.none' ? null : a === 'x.y.held' ? 'held' as const : a === 'x.y.prompt' ? 'prompt' as const : 'run' as const);

  it('types each item, leaves out an action with no door, drops an emptied submenu, collapses separators', () => {
    const b = buildItems([
      item({ id: 0, kind: 'separator' }),
      item({ id: 1, action: 'x.y.run', key: 'R' }),
      item({ id: 2, action: 'x.y.none' }),
      item({ id: 0, kind: 'separator' }),
      item({ id: 3, kind: 'submenu', label: 'Sub', items: [item({ id: 4, action: 'x.y.none' }), item({ id: 0, kind: 'separator' })] }),
      item({ id: 0, kind: 'separator' }),
      item({ id: 5, label: '1 R1', kind: 'normal' }),
      item({ id: 6, kind: 'check', action: 'x.y.held', checked: true }),
      item({ id: 7, kind: 'radio' }),
      item({ id: 8, action: 'x.y.prompt', enabled: false }),
      item({ id: 0, kind: 'separator' }),
    ], doors);
    expect(b.items.map((i) => [i.id, i.type, i.door])).toEqual([[1, 'action', 'run'], [0, 'separator', 'run'], [5, 'choice', 'run'], [6, 'check', 'held'], [7, 'radio', 'run'], [8, 'action', 'prompt']]);
    expect(b.omitted).toEqual(['x.y.none']);
    expect(Object.keys(b.items[0]).sort()).toEqual(['action', 'checked', 'door', 'enabled', 'id', 'key', 'label', 'type']);
    expect([...b.sent.keys()].sort((p, q) => p - q)).toEqual([1, 5, 6, 7, 8]);
    expect(b.sent.get(8)).toEqual({ type: 'action', enabled: false });
  });

  it('keeps a submenu with its items, the caret item\'s own key and check cleared', () => {
    const b = buildItems([item({ id: 3, kind: 'submenu', label: 'Sub', key: 'X', checked: true, items: [item({ id: 4, action: 'x.y.run' })] })], doors);
    expect(b.items).toEqual([{ id: 3, type: 'submenu', action: '', label: 'Sub', enabled: true, checked: false, key: '', door: 'run', items: [{ id: 4, type: 'action', action: 'x.y.run', label: 'x', enabled: true, checked: false, key: '', door: 'run' }] }]);
    expect(b.sent.get(3)).toEqual({ type: 'submenu', enabled: true });
  });

  it('collapses separators at the start, the end and in runs', () => {
    const sep = { id: 0, type: 'separator', action: '', label: '', enabled: false, checked: false, key: '', door: 'run' } as MenuItem;
    const a = { ...sep, id: 1, type: 'action' } as MenuItem;
    expect(collapse([sep, sep, a, sep, sep, a, sep])).toEqual([a, sep, a]);
    expect(collapse([sep])).toEqual([]);
  });
});

describe('the doors (the table and the held union)', () => {
  const union = heldActions();
  it('a held action of this frame with its cap listed is held, whatever the table says', () => {
    expect(doorOf('pcbnew.DRCTool.runDRC', 'pcb', ['drc'], union)).toBe('held');
    expect(doorOf('pcbnew.DRCTool.runDRC', 'pcb', [], union)).toBe('run');
    expect(HELD_ACTIONS.some((h) => h.action === 'pcbnew.DRCTool.runDRC')).toBe(true);
  });

  it('a prompt door needs the prompts cap, a form door its own cap, a held row its holder; an unnamed action runs', () => {
    expect(doorOf('pcbnew.InteractiveEdit.moveExact', 'pcb', [], union)).toBeNull();
    expect(doorOf('pcbnew.InteractiveEdit.moveExact', 'pcb', [PROMPTS_CAP], union)).toBe('prompt');
    expect(doorOf('pcbnew.InteractiveEdit.properties', 'pcb', [], union)).toBeNull();
    expect(doorOf('pcbnew.InteractiveEdit.properties', 'pcb', ['boardItemKinds'], union)).toBe('run');
    expect(doorOf('eeschema.InteractiveEdit.changeSymbol', 'sch', ['heldKeys', 'heldMenus'], [])).toBeNull();
    expect(doorOf('eeschema.InteractiveEdit.changeSymbol', 'sch', ['bulk'], [{ action: 'eeschema.InteractiveEdit.changeSymbol', frames: ['sch'], cap: 'bulk' }])).toBe('held');
    expect(doorOf('eeschema.InteractiveEdit.rotateCCW', 'sch', [], union)).toBe('run');
    expect(doorOf('common.Interactive.copy', 'ds' as never, [], union)).toBe('run');
  });
});

describe('a right click on run 15: ev.contextMenu', () => {
  it('takes the menu, sends it with exactly its keys, marks the frame as a popup does and holds ev.menu', () => {
    const t = fakeCtx('sch', RUN15());
    expect(t.w.kicadHostMenu?.onMenu?.(SCH_MENU())).toBe(true);
    const [ev] = contextMenus(t.emitted);
    expect(Object.keys(ev)).toEqual(['type', 'token', 'clarify', 'frame', 'at', 'title', 'kinds', 'items', 'omitted']);
    expect(ev).toMatchObject({ token: 7, clarify: false, frame: 'sch', at: { x: 10, y: 20 }, title: '', kinds: ['symbol'] });
    // Change Symbol has no holder landed here and Properties no form cap: both left out, never grayed.
    expect(ev.omitted).toEqual(['eeschema.InteractiveEdit.changeSymbol', 'eeschema.InteractiveEdit.properties']);
    expect((ev.items as MenuItem[]).map((i) => i.type)).toEqual(['action', 'separator', 'submenu']);
    expect(t.held()).toBe(1);
    expect(t.ctx.keysBlocked()).toBe(true);
    expect(t.w.document.children[0].attrs[MARKER_ATTR]).toBe('7');
    expect(t.w.document.children[0].hidden).toBe(true);
  });

  it('answers falsy (KiCad\'s popup) without the cap, a document, ev.ready, during an import, or for a model of another shape', () => {
    for (const s of [{ caps: [] }, { doc: false }, { ready: false }, { importing: true }, { closed: true }]) {
      const t = fakeCtx('sch', RUN15(), s);
      expect(t.w.kicadHostMenu?.onMenu?.(SCH_MENU())).toBe(false);
      expect(t.emitted).toEqual([]);
      expect(t.ctx.keysBlocked()).toBe(false);
    }
    const t = fakeCtx('sch', RUN15());
    expect(t.w.kicadHostMenu?.onMenu?.('{"token":1}')).toBe(false);
    expect(t.held()).toBe(0);
  });

  it('maps the canvas point through the drawing canvas\'s rect', () => {
    const doc = { querySelectorAll: () => [{ width: 2000, height: 1000, getBoundingClientRect: () => ({ left: 10, top: 5, width: 1000 }) }] };
    expect(cssPoint(doc, { x: 400, y: 100 })).toEqual({ x: 210, y: 55 });
    expect(cssPoint({ querySelectorAll: () => [] }, { x: 4, y: 1 })).toEqual({ x: 4, y: 1 });
  });

  it('a new menu while one is parked: the old one is gone', () => {
    const t = fakeCtx('sch', RUN15());
    t.w.kicadHostMenu!.onMenu!(SCH_MENU(7));
    t.w.kicadHostMenu!.onMenu!(SCH_MENU(8));
    expect(ends(t.emitted)).toEqual([{ type: 'ev.contextMenuEnd', token: 7, reason: 'gone' }]);
    expect(t.w.document.children.length).toBe(1);
    expect(t.w.document.children[0].attrs[MARKER_ATTR]).toBe('8');
  });
});

describe('contextMenu.choose and contextMenu.highlight', () => {
  const choose = unit.ops!['contextMenu.choose'];
  const highlight = unit.ops!['contextMenu.highlight'];

  it('chooses a sent item: the engine replays it, the marker goes, no end event', async () => {
    vi.useFakeTimers();
    const mod = RUN15();
    const t = fakeCtx('sch', mod);
    t.w.kicadHostMenu!.onMenu!(SCH_MENU());
    expect(await choose.run({ token: 7, id: 101 }, t.ctx)).toEqual({ ok: true, result: {} });
    expect(mod.kicadContextMenuChoose).toHaveBeenCalledWith(7, 101);
    expect(t.ctx.keysBlocked()).toBe(false);
    expect(ends(t.emitted)).toEqual([]);
    expect(t.held()).toBe(1);
    vi.advanceTimersByTime(200);
    expect(t.held()).toBe(0);
    expect(await choose.run({ token: 7, id: 101 }, t.ctx)).toEqual({ ok: false, code: 'stale', message: 'contextMenu.choose' });
  });

  it('id -1 cancels with no edit and no end event', async () => {
    const mod = RUN15();
    const t = fakeCtx('sch', mod);
    t.w.kicadHostMenu!.onMenu!(SCH_MENU());
    expect(await choose.run({ token: 7, id: -1 }, t.ctx)).toEqual({ ok: true, result: {} });
    expect(mod.kicadContextMenuChoose).toHaveBeenCalledWith(7, -1);
    expect(ends(t.emitted)).toEqual([]);
  });

  it('refuses closed: bad args, a stale token, an omitted or unknown item, a submenu, a disabled item', async () => {
    const mod = RUN15();
    const t = fakeCtx('sch', mod);
    t.w.kicadHostMenu!.onMenu!(SCH_MENU());
    const ans = (code: string) => ({ ok: false, code, message: 'contextMenu.choose' });
    expect(await choose.run({ token: 7 }, t.ctx)).toEqual(ans('bad_args'));
    expect(await choose.run({ token: 7, id: 1.5 }, t.ctx)).toEqual(ans('bad_args'));
    expect(await choose.run({ token: 7, id: 101, x: 1 }, t.ctx)).toEqual(ans('bad_args'));
    expect(await choose.run({ token: 8, id: 101 }, t.ctx)).toEqual(ans('stale'));
    expect(await choose.run({ token: 7, id: 102 }, t.ctx)).toEqual(ans('no_item'));
    expect(await choose.run({ token: 7, id: 999 }, t.ctx)).toEqual(ans('no_item'));
    expect(await choose.run({ token: 7, id: 103 }, t.ctx)).toEqual(ans('no_item'));
    expect(mod.kicadContextMenuChoose).not.toHaveBeenCalled();
    expect(t.ctx.keysBlocked()).toBe(true);
  });

  it('maps the engine\'s codes; a stale answer ends the park', async () => {
    const mod = RUN15({ kicadContextMenuChoose: vi.fn(() => 3) });
    const t = fakeCtx('sch', mod);
    t.w.kicadHostMenu!.onMenu!(SCH_MENU());
    expect(await choose.run({ token: 7, id: 105 }, t.ctx)).toMatchObject({ ok: false, code: 'disabled' });
    expect(t.ctx.keysBlocked()).toBe(true);
    mod.kicadContextMenuChoose = vi.fn(() => 1);
    expect(await choose.run({ token: 7, id: 105 }, t.ctx)).toMatchObject({ ok: false, code: 'stale' });
    expect(t.ctx.keysBlocked()).toBe(false);
  });

  it('answers unsupported on an engine without the exports', async () => {
    const t = fakeCtx('sch', { kicadHostActions: () => true });
    expect(await choose.run({ token: 1, id: 1 }, t.ctx)).toEqual({ ok: false, code: 'unsupported', message: 'kicadContextMenuChoose' });
    expect(await highlight.run({ token: 1, id: 1 }, t.ctx)).toEqual({ ok: false, code: 'unsupported', message: 'kicadContextMenuHighlight' });
  });

  it('highlights a candidate and keeps the menu; an engine that ended the wait says gone', async () => {
    const mod = RUN15();
    const t = fakeCtx('pcb', mod);
    const clarify = MENU(9, [item({ id: 1, label: 'Footprint R1' }), item({ id: 2, label: 'Pad 1 of R1' })], { clarify: true, title: 'Clarify Selection' });
    t.w.kicadHostMenu!.onMenu!(clarify);
    expect(contextMenus(t.emitted)[0]).toMatchObject({ clarify: true, title: 'Clarify Selection', omitted: [] });
    expect(await highlight.run({ token: 9, id: 2 }, t.ctx)).toEqual({ ok: true, result: {} });
    expect(mod.kicadContextMenuHighlight).toHaveBeenCalledWith(9, 2);
    expect(await highlight.run({ token: 9, id: -1 }, t.ctx)).toMatchObject({ code: 'bad_args' });
    mod.kicadContextMenuHighlight = vi.fn(() => 1);
    expect(await highlight.run({ token: 9, id: 1 }, t.ctx)).toMatchObject({ code: 'stale' });
    expect(ends(t.emitted)).toEqual([{ type: 'ev.contextMenuEnd', token: 9, reason: 'gone' }]);
  });
});

describe('ending the menu from the frame', () => {
  it('Escape in the frame cancels it (the key never reaches KiCad), and says canceled', () => {
    const mod = RUN15();
    const t = fakeCtx('sch', mod);
    t.w.kicadHostMenu!.onMenu!(SCH_MENU());
    const e = t.w.fire(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(e.defaultPrevented).toBe(true);
    expect(mod.kicadContextMenuChoose).toHaveBeenCalledWith(7, -1);
    expect(ends(t.emitted)).toEqual([{ type: 'ev.contextMenuEnd', token: 7, reason: 'canceled' }]);
    expect(t.ctx.keysBlocked()).toBe(false);
  });

  it('a press in the frame cancels it', () => {
    const t = fakeCtx('pcb', RUN15());
    t.w.kicadHostMenu!.onMenu!(SCH_MENU());
    t.w.fire(new Event('pointerdown'));
    expect(ends(t.emitted)).toEqual([{ type: 'ev.contextMenuEnd', token: 7, reason: 'canceled' }]);
  });

  it('a save closes it as it closes KiCad\'s popup (bridge/modal.ts dismissPopups), then nothing blocks the keys', () => {
    const mod = RUN15();
    const t = fakeCtx('sch', mod);
    t.w.kicadHostMenu!.onMenu!(SCH_MENU());
    expect(dismissPopups(t.w as never)).toBe(true);
    expect(keysBlocked(t.w as never)).toBe(false);
    expect(mod.kicadContextMenuChoose).toHaveBeenCalledWith(7, -1);
    expect(ends(t.emitted)).toEqual([{ type: 'ev.contextMenuEnd', token: 7, reason: 'canceled' }]);
  });

  it('a cancel the engine finds stale says gone', () => {
    const t = fakeCtx('sch', RUN15({ kicadContextMenuChoose: vi.fn(() => 1) }));
    t.w.kicadHostMenu!.onMenu!(SCH_MENU());
    t.w.fire(new Event('pointerdown'));
    expect(ends(t.emitted)).toEqual([{ type: 'ev.contextMenuEnd', token: 7, reason: 'gone' }]);
  });

  it('the close cancels it, takes the slot back and leaves no listener', () => {
    const mod = RUN15();
    const t = fakeCtx('sch', mod);
    t.w.kicadHostMenu!.onMenu!(SCH_MENU());
    t.stop();
    expect(mod.kicadContextMenuChoose).toHaveBeenCalledWith(7, -1);
    expect(t.w.kicadHostMenu).toBeUndefined();
    for (const l of t.w.listeners.values()) expect(l).toEqual([]);
  });
});

describe('action.run', () => {
  const run = unit.ops!['action.run'];
  const ans = (code: string, message = 'action.run') => ({ ok: false, code, message });

  it('runs a tool action by name in the engine', async () => {
    const mod = RUN15();
    const t = fakeCtx('sch', mod);
    expect(await run.run({ name: 'eeschema.InteractiveEdit.rotateCCW' }, t.ctx)).toEqual({ ok: true, result: {} });
    expect(mod.kicadRunAction).toHaveBeenCalledWith('eeschema.InteractiveEdit.rotateCCW');
  });

  it('refuses closed args, a held action (before the engine), an engine without it, and no document', async () => {
    const mod = RUN15();
    const t = fakeCtx('pcb', mod, { caps: [CONTEXT_MENU_CAP, 'drc'] });
    expect(await run.run({ name: 'no' }, t.ctx)).toEqual(ans('bad_args'));
    expect(await run.run({ name: 'a.b', x: 1 }, t.ctx)).toEqual(ans('bad_args'));
    expect(await run.run(undefined, t.ctx)).toEqual(ans('bad_args'));
    expect(await run.run({ name: 'pcbnew.DRCTool.runDRC' }, t.ctx)).toEqual(ans('held', 'pcbnew.DRCTool.runDRC'));
    expect(mod.kicadRunAction).not.toHaveBeenCalled();
    expect(await run.run({ name: 'a.b' }, fakeCtx('pcb', {}).ctx)).toEqual(ans('unsupported', 'kicadRunAction'));
    expect(await run.run({ name: 'a.b' }, fakeCtx('pcb', RUN15(), { doc: false }).ctx)).toEqual(ans('not_ready'));
  });

  it('refuses an action whose window has no door in this frame, never opening it', async () => {
    const mod = RUN15();
    const t = fakeCtx('pcb', mod);
    const r = await run.run({ name: 'pcbnew.InteractiveEdit.moveExact' }, t.ctx);
    expect(r).toMatchObject({ ok: false, code: 'unsupported' });
    expect(mod.kicadRunAction).not.toHaveBeenCalled();
    const p = fakeCtx('pcb', mod, { caps: [CONTEXT_MENU_CAP, PROMPTS_CAP] });
    expect(await run.run({ name: 'pcbnew.InteractiveEdit.moveExact' }, p.ctx)).toEqual({ ok: true, result: {} });
  });

  it('answers busy while a menu is parked, a load runs or an item hangs', async () => {
    const t = fakeCtx('sch', RUN15());
    t.w.kicadHostMenu!.onMenu!(SCH_MENU());
    expect(await run.run({ name: 'a.b' }, t.ctx)).toEqual(ans('busy'));
    expect(await run.run({ name: 'a.b' }, fakeCtx('sch', RUN15(), { busy: true }).ctx)).toEqual(ans('busy'));
    expect(await run.run({ name: 'a.b' }, fakeCtx('sch', RUN15(), { hanging: true }).ctx)).toEqual(ans('busy'));
  });

  it('maps the engine\'s codes', async () => {
    const at = async (c: number) => run.run({ name: 'no.Such.thing' }, fakeCtx('sch', RUN15({ kicadRunAction: () => c })).ctx);
    expect(await at(1)).toEqual(ans('unknown_action', 'no.Such.thing'));
    expect(await at(3)).toEqual(ans('busy'));
    expect(await at(4)).toEqual(ans('not_ready'));
    expect(await at(9)).toMatchObject({ code: 'island_error' });
  });
});

describe('the keyboard menu', () => {
  const key = (k: string, extra: Record<string, unknown> = {}) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra });

  it('the ContextMenu key and Shift+F10 run KiCad\'s keyboard menu, and the browser\'s own contextmenu after it is dropped', () => {
    const mod = RUN15();
    const t = fakeCtx('sch', mod);
    expect(t.w.fire(key('ContextMenu')).defaultPrevented).toBe(true);
    expect(mod.kicadRunAction).toHaveBeenLastCalledWith(SHOW_CONTEXT_MENU);
    const after = Object.assign(new Event('contextmenu', { cancelable: true }), { button: 0 });
    expect(t.w.fire(after).defaultPrevented).toBe(true);
    const pointer = Object.assign(new Event('contextmenu', { cancelable: true }), { button: 2 });
    expect(t.w.fire(pointer).defaultPrevented).toBe(false);
    t.w.fire(key('F10', { shiftKey: true }));
    expect(mod.kicadRunAction).toHaveBeenCalledTimes(2);
  });

  it('leaves the keys to KiCad in a text field, without the cap, or with something over the canvas', () => {
    const mod = RUN15();
    const field = fakeCtx('sch', mod);
    const e = key('ContextMenu');
    Object.defineProperty(e, 'target', { value: { tagName: 'INPUT' } });
    field.w.fire(e);
    fakeCtx('sch', mod, { caps: [] }).w.fire(key('ContextMenu'));
    fakeCtx('sch', mod).w.fire(key('F10'));
    const up = fakeCtx('sch', mod);
    up.w.kicadHostMenu!.onMenu!(SCH_MENU());
    up.w.fire(key('ContextMenu'));
    expect(mod.kicadRunAction).not.toHaveBeenCalled();
  });
});
