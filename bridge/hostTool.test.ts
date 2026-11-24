// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The tool KiCad holds (bridge/hostTool.ts): the engine's call read closed,
// the slot taken once before boot and listened to after.
import { describe, expect, it, vi } from 'vitest';
import { hostToolSlot, readActiveTool, readToolChange, SELECTION_TOOL, type HostToolWindow } from './hostTool';

const ROUTE = 'pcbnew.InteractiveRouter.SingleTrack';

describe('readToolChange', () => {
  it('reads exactly { tool }, a dotted tool name', () => {
    expect(readToolChange(JSON.stringify({ tool: ROUTE }))).toBe(ROUTE);
    expect(readToolChange(JSON.stringify({ tool: SELECTION_TOOL }))).toBe(SELECTION_TOOL);
    expect(readToolChange('{"tool":"pl_editor"}')).toBe('pl_editor');
  });

  it('refuses any other shape', () => {
    for (const bad of [
      '{"tool":""}', '{"tool":1}', '{"tool":"a b"}', '{"tool":"a..b"}', `{"tool":"${'a'.repeat(129)}"}`, '{"tool":"x","more":1}',
      '{}', '[]', 'null', 'tool', '',
    ]) expect(readToolChange(bad), bad).toBeNull();
    expect(readToolChange({ tool: ROUTE })).toBeNull();
  });

  it('reads kicadActiveTool()\'s answer: a name, null for "" or anything else', () => {
    expect(readActiveTool(ROUTE)).toBe(ROUTE);
    for (const bad of ['', 1, null, undefined, 'a b']) expect(readActiveTool(bad)).toBeNull();
  });
});

describe('hostToolSlot', () => {
  it('takes the slot once: a later call answers the same handle, a slot of another kind is replaced', () => {
    const w: HostToolWindow = {};
    const a = hostToolSlot(w);
    const slot = w.kicadHostTool;
    expect(typeof slot?.onChange).toBe('function');
    expect(hostToolSlot(w)).toBe(a);
    expect(w.kicadHostTool).toBe(slot);
    const other: HostToolWindow = { kicadHostTool: { onChange: () => {} } };
    hostToolSlot(other);
    expect(other.kicadHostTool).not.toBe(slot);
  });

  it('remembers the last name read before any listener, then hands each later one to the listener until its stop', () => {
    const w: HostToolWindow = {};
    const h = hostToolSlot(w);
    const say = (text: unknown) => w.kicadHostTool?.onChange?.(text);
    expect(h.latest()).toBeNull();
    say(JSON.stringify({ tool: ROUTE }));
    expect(h.latest()).toBe(ROUTE);
    const fn = vi.fn();
    const stop = h.listen(fn);
    say('{"tool":7}');
    say(JSON.stringify({ tool: SELECTION_TOOL }));
    expect(fn.mock.calls).toEqual([[SELECTION_TOOL]]);
    expect(h.latest()).toBe(SELECTION_TOOL);
    stop();
    say(JSON.stringify({ tool: ROUTE }));
    expect(fn).toHaveBeenCalledTimes(1);
    h.listen(() => { throw new Error('host gone'); });
    expect(() => say(JSON.stringify({ tool: SELECTION_TOOL }))).not.toThrow();
  });
});
