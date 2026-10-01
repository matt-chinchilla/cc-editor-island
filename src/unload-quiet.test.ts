// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installUnloadQuiet, isQuiet, quietClear, quietFor, quietForever, resetUnloadQuietForTest } from './unload-quiet';

describe('unload quiet', () => {
  beforeEach(() => resetUnloadQuietForTest());

  it('is off until asked, on for the window it was given, then off again', () => {
    expect(isQuiet(1_000)).toBe(false);
    quietFor(10_000, 1_000);
    expect(isQuiet(1_000)).toBe(true);
    expect(isQuiet(10_999)).toBe(true);
    expect(isQuiet(11_000)).toBe(false);
  });

  it('never shortens a window already open', () => {
    quietFor(10_000, 1_000);
    quietFor(1_000, 2_000);
    expect(isQuiet(5_000)).toBe(true);
    quietFor(10_000, 5_000);
    expect(isQuiet(14_000)).toBe(true);
  });

  it('stays on for good after quietForever', () => {
    quietForever();
    expect(isQuiet(0)).toBe(true);
    expect(isQuiet(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('is off again after quietClear, both the forever flag and an open window', () => {
    quietForever();
    quietFor(10_000, 1_000);
    quietClear();
    expect(isQuiet(1_000)).toBe(false);
    expect(isQuiet(Number.MAX_SAFE_INTEGER)).toBe(false);
    quietFor(10_000, 1_000);
    expect(isQuiet(5_000)).toBe(true);
  });

  it('stops the handlers registered after it only while quiet, and never sets returnValue', () => {
    const target = new EventTarget();
    const quit = vi.fn();
    target.addEventListener('beforeunload', quit, { capture: true });   // the quit latch, installed first
    installUnloadQuiet(target as unknown as Window);
    const engine = vi.fn((e: Event) => { e.preventDefault(); (e as unknown as { returnValue: unknown }).returnValue = 'unsaved'; });
    target.addEventListener('beforeunload', engine, { capture: true });  // the engine's own prompt

    const fire = () => {
      const e = new Event('beforeunload', { cancelable: true }) as Event & { returnValue: unknown };
      // Node's Event has a read-only returnValue; a BeforeUnloadEvent's is writable.
      Object.defineProperty(e, 'returnValue', { value: undefined, writable: true });
      target.dispatchEvent(e);
      return e;
    };
    fire();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(engine).toHaveBeenCalledTimes(1);

    quietFor(10_000);
    const quiet = fire();
    expect(quit).toHaveBeenCalledTimes(2);
    expect(engine).toHaveBeenCalledTimes(1);
    expect(quiet.defaultPrevented).toBe(false);
    expect(quiet.returnValue).toBeUndefined();
  });
});
