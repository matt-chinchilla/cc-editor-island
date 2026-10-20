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

/** `git grep -n <pattern>` over the KiCad clone at `commit` in files matching `glob`, as `path:line:text` lines; null without the clone. */
export function kicadGrepAt(commit, pattern, glob) {
  if (!hasKicadClone()) return null;
  try {
    const out = execFileSync('git', ['-C', CLONE, 'grep', '-n', '-e', pattern, commit, '--', glob], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return out.split('\n').filter((l) => l !== '').map((l) => l.slice(commit.length + 1));
  } catch (err) {
    if (err?.status === 1) return [];   // git grep found nothing
    throw err;
  }
}
