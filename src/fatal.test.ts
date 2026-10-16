// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { createFatalGate, type FatalCode } from './fatal';

function gate(o: { started?: boolean } = {}) {
  const shown: Array<FatalCode | undefined> = [];
  const emitted: FatalCode[] = [];
  const logged: string[] = [];
  const g = createFatalGate({
    started: () => o.started === true,
    show: (code) => shown.push(code),
    emit: (code) => emitted.push(code),
    oom: (text) => /out of memory/i.test(text),
    log: (raw) => logged.push(raw),
  });
  return { g, shown, emitted, logged };
}

describe('the fatal gate', () => {
  it('a crash outside an import shows the fatal screen and emits ev.state fatal once', () => {
    const { g, shown, emitted, logged } = gate();
    g.uncaught('RuntimeError: unreachable');
    g.uncaught('RuntimeError: memory access out of bounds');
    g.die('webgl_lost');
    expect(shown).toEqual(['crash']);
    expect(emitted).toEqual(['crash']);
    expect(logged).toEqual(['RuntimeError: unreachable']);
    expect(g.isFatal()).toBe(true);
  });

  it('out of memory is memory, and an uncaught error that is no trap is nothing', () => {
    const a = gate();
    a.g.uncaught('TypeError: x is undefined');
    expect(a.emitted).toEqual([]);
    expect(a.g.isFatal()).toBe(false);
    a.g.uncaught('Aborted(Cannot enlarge memory arrays): out of memory');
    expect(a.emitted).toEqual(['memory']);
  });

  it('an import whose call trapped shows the fatal screen and emits nothing, and nothing after it emits either', () => {
    const { g, shown, emitted, logged } = gate();
    g.importStopped('the engine stopped: RuntimeError: unreachable');
    expect(shown).toEqual(['crash']);
    expect(emitted).toEqual([]);
    expect(logged).toEqual(['the engine stopped: RuntimeError: unreachable']);
    g.uncaught('RuntimeError: unreachable');
    g.die('crash');
    expect(emitted).toEqual([]);
    expect(g.latch()).toBe(false);
  });

  it('after the teardown started nothing is shown or emitted, and the quit latch takes the state once', () => {
    const t = gate({ started: true });
    t.g.uncaught('RuntimeError: unreachable');
    t.g.die('boot_failed');
    t.g.importStopped('the engine stopped: RuntimeError: unreachable');
    expect([t.shown, t.emitted]).toEqual([[], []]);
    const q = gate();
    expect(q.g.latch()).toBe(true);
    expect(q.g.latch()).toBe(false);
    q.g.die('crash');
    expect(q.emitted).toEqual([]);
  });
});
