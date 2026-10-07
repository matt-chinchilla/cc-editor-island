// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// scripts/build-libs.mjs holds the sources to PIN.json before it builds: the
// tag must be PIN.json libs.tag and each checkout must sit at the commit
// PIN.json libs pins, with no local changes. Anything else is refused (exit 1)
// before a byte is written; a malformed command line is a usage error (exit 2).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMirror } from '../../scripts/libs/mirror.mjs';
import { fixtureSources, gitCommitAll, listDir, pinJson, removeDir, runCli, tempDir, writeTree } from './kit.mjs';

const dirs: string[] = [];
const scratch = (p: string) => { const d = tempDir(p); dirs.push(d); return d; };
let src: { symbolsSrc: string; footprintsSrc: string };
let out: string;

beforeAll(() => {
  src = fixtureSources(scratch('cc-libs-cli'));
  gitCommitAll(src.symbolsSrc);
  gitCommitAll(src.footprintsSrc);
  out = scratch('cc-libs-cli-out');
});
afterAll(() => { for (const d of dirs) removeDir(d); });

describe('build-libs.mjs', () => {
  it('refuses a source checkout that is not at the PIN.json commit', () => {
    const r = runCli(['--out', out, '--symbols-src', src.symbolsSrc, '--footprints-src', src.footprintsSrc]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(new RegExp(`^refused: ${src.symbolsSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is at [0-9a-f]{40}, PIN.json libs.symbols.commit pins ${pinJson().libs.symbols.commit}`));
    expect(listDir(out)).toEqual([]);
  });

  it('refuses a source that is not a git checkout', () => {
    const plain = fixtureSources(scratch('cc-libs-plain'));
    const r = runCli(['--out', out, '--symbols-src', plain.symbolsSrc, '--footprints-src', plain.footprintsSrc]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^refused: .* is not a git checkout, so its commit cannot be checked against PIN.json libs.symbols.commit/);
  });

  it('refuses a tag other than PIN.json\'s', () => {
    const r = runCli(['--out', out, '--tag', '9.0.0', '--symbols-src', src.symbolsSrc, '--footprints-src', src.footprintsSrc]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`refused: PIN.json pins the libraries at ${pinJson().libs.tag}; to build 9.0.0, bump PIN.json libs`);
  });

  it('pins the libraries to the engine\'s KiCad 10.0.x tag and two full commits', () => {
    const libs = pinJson().libs;
    expect(libs.tag).toMatch(/^10\.0\.\d+$/);
    expect(libs.symbols.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(libs.footprints.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('turns a malformed command line into a usage error', () => {
    for (const args of [
      [],
      ['--out', out],
      ['--out', out, '--symbols-src', src.symbolsSrc],
      ['--out', out, '--clone', out, '--symbols-src', src.symbolsSrc, '--footprints-src', src.footprintsSrc],
      ['--out', out, '--clone', out, '--only', ','],
      ['--out'],
      ['--verify', out, '--out', out],
      ['--bogus'],
    ]) {
      const r = runCli(args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr, args.join(' ')).toContain('usage: node scripts/build-libs.mjs');
    }
  });

  it('verifies a mirror alone with --verify, and fails on one that is not', async () => {
    const built = await buildMirror({ ...src, out: scratch('cc-libs-verify-ok'), tag: pinJson().libs.tag });
    const ok = runCli(['--verify', built.dir]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(`verified ${built.dir} (tag ${pinJson().libs.tag})`);
    expect(ok.stdout).toContain('symbol libraries: 4, items: 9');
    const empty = scratch('cc-libs-verify');
    writeTree(empty, { 'manifest.json': '{}' });
    const r = runCli(['--verify', empty]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('build-libs: manifest.json is not stored gzipped');
  });
});
