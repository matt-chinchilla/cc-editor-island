// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The node side of the tests that check the island against the engine's own
// source: a file of the KiCad clone the engine was built from
// ($CC_ENGINE_ROOT/kicad-source-mirror, default /home/matthew/cc-engine, as
// scripts/fetch-engine.mjs reads it), at one commit. Null on a machine without
// the clone, so those tests skip there.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const CLONE = join(process.env.CC_ENGINE_ROOT ?? '/home/matthew/cc-engine', 'kicad-source-mirror');

/** Whether the engine's KiCad clone is on disk. */
export function hasKicadClone() {
  return existsSync(join(CLONE, '.git'));
}

/** `path` of the KiCad clone at `commit`, as text; null without the clone. Throws when git cannot show it. */
export function kicadFileAt(commit, path) {
  if (!hasKicadClone()) return null;
  return execFileSync('git', ['-C', CLONE, 'show', `${commit}:${path}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}
