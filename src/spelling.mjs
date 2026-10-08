// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The node side of src/americanSpelling.test.ts: every tracked text file's
// lines that carry the British spelling of color. The pattern spells the word
// with a character class so this file never carries it.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = /\.(ts|tsx|mjs|mts|js|css|json|md|html|txt|sh|yml|yaml|svg)$/;
const BRITISH = /colo[u]r/i;

export function britishSpellings() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((rel) => TEXT.test(rel));
  const hits = [];
  for (const rel of files) {
    const path = join(ROOT, rel);
    if (statSync(path, { throwIfNoEntry: false })?.isFile() !== true) continue;
    readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
      if (BRITISH.test(line)) hits.push(`${rel}:${i + 1}`);
    });
  }
  return hits;
}
