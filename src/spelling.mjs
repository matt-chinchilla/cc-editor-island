// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The node side of src/americanSpelling.test.ts: every tracked text file's
// lines that carry a British spelling (the owner's words: "I am not british").
// Every pattern spells its word with a character class so this
// file never carries one. Not ours to respell, so skipped: the pristine
// upstream copies, the notices reproduced unchanged, and LICENSE; ALLOWED is
// the official name of the wxWindows license.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = /\.(ts|tsx|mjs|mts|js|css|json|md|html|txt|sh|yml|yaml|svg)$/;
const NOT_OURS = /^(loader\/pristine\/|notices\/(pcbjam-licenses\.md|kicad-LICENSE\.README|phosphor-LICENSE|versions\.sh)$|LICENSE)/;
const ALLOWED = /wxWindows (Library )?Licen[c]e/g;
const IS_STEMS = [
  'normal', 'recogn', 'raster', 'canonical', 'categor', 'capital', 'memo', 'author', 'serial', 'material', 'summar',
  'optim', 'quant', 'emphas', 'initial', 'token', 'personal', 'general', 'editorial', 'synthes', 'neutral', 'sanit',
  'priorit', 'amort', 'panel', 'monet', 'commodit', 'character', 'organ', 'parenthes', 'standard', 'stabil', 'item',
  'modular', 'central', 'linear', 'factor', 'paramete?r', 'discret', 'ellips', 'singular', 'final', 'local', 'minim',
  'maxim', 'real', 'util', 'visual', 'special', 'custom', 'synchron', 'apolog', 'critic', 'random', 'vector', 'legal',
  'harmon', 'mobil', 'polar', 'regular', 'digit', 'formal', 'popular', 'symbol', 'hypothes', 'miniatur', 'subsid',
  'sympath', 'theor', 'trivial', 'ideal', 'modern', 'rational', 'sensit', 'steril', 'fertil', 'magnet', 'oxid',
  'privat', 'scrutin', 'virtual', 'anonym', 'binar', 'container', 'equal', 'italic', 'industrial', 'homogen', 'immun',
  'jeopard', 'marginal', 'memor', 'mechan', 'national', 'natural', 'penal', 'pulver', 'satir', 'scandal', 'schemat',
  'secular', 'stigmat', 'tyrann', 'urban', 'vandal', 'verbal', 'victim', 'western',
];
const BRITISH = new RegExp(
  [
    '(colo|behavio|favo|hono|labo|neighbo|flavo|harbo|humo|rumo|vapo|armo|savo|endeavo|odo|rigo|vigo|clamo|splendo|valo|parlo)[u]r',
    '(cent|met|lit|fib|theat|calib|spect|lust|meag|manoeuv)r[e]',
    'sombr[e]s?(?![a-z])',
    'centr(ed|ing)(?![a-z])',
    'gr[e]y',
    'licen[c]e',
    '(defen|offen|preten)[c]e',
    '(catal|anal|dial)og[u]e',
    'programm[e]s?(?![a-z])',
    '(cancel|label|model|travel|signal|level|fuel|channel|tunnel|total|jewel|quarrel|rival|equal|pedal|shovel|grovel|swivel|unravel)l(ed|ing|er|ers)(?![a-z])',
    `(${IS_STEMS.join('|')})i[s](e|ed|es|ing|er|ers|ation|ations|able)(?![a-z])`,
    '(analy|paraly|cataly)[s](e|ed|ing|er|ers)(?![a-z])',
    'pract[i]s(e|ed|ing)(?![a-z])',
    'alumin[i]um', 'judg[e]ments?', 'acknowledg[e]ments?', 'art[e]facts?', 'sulph[u]r', 'che[q]ue', 'plou[g]h',
    'jewel[l]ery', 'marvel[l]ous', 'enrol[m]ent', 'instal[m]ent', 'skil[f]ul', 'wil[f]ul', 'speci[a]lity', 'sc[e]ptic',
    '\\bmath[s]\\b', '\\blearn[t]\\b', '\\bspel[t]\\b', '\\bdream[t]\\b', '\\bwhils[t]\\b', '\\bamongs[t]\\b',
    '\\bmo[u]ld(s|ed|ing)?\\b', '\\bt[y]res?\\b', '\\bk[e]rb\\b', '\\bstor[e]ys?\\b', '\\bage[i]ng\\b', '\\bco[s]y\\b',
    '\\bfulfi[l]s?\\b',
  ].join('|'),
  'i',
);

export function britishSpellings() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((rel) => TEXT.test(rel) && !NOT_OURS.test(rel));
  const hits = [];
  for (const rel of files) {
    const path = join(ROOT, rel);
    if (statSync(path, { throwIfNoEntry: false })?.isFile() !== true) continue;
    readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
      const m = line.replace(ALLOWED, '').match(BRITISH);
      if (m) hits.push(`${rel}:${i + 1} ${m[0]}`);
    });
  }
  return hits;
}
