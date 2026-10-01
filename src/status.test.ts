// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import bootSource from '../loader/src/wasm/boot.ts?raw';
import { statusFatal } from './status';

describe('statusFatal', () => {
  it('maps the loader context-lost line to webgl_lost and nothing else', () => {
    // The exact line the loader's webglcontextlost listener reports (a tripwire if boot.ts rewords it).
    const line = /onStatus\("(WebGL context lost[^"]*)"\)/.exec(bootSource)?.[1];
    expect(line).toBeDefined();
    expect(statusFatal(line as string)).toBe('webgl_lost');
    for (const ordinary of ['Starting the editor…', 'Compiling…', 'Starting KiCad…', 'Error: boom', '', 'the WebGL context lost earlier']) {
      expect(statusFatal(ordinary)).toBeNull();
    }
  });
});
