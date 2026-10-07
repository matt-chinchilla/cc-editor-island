// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The picker's two search indexes (PICKER.md section 1, LIBRARY.md):
// sym-index.json, one row per symbol, and fp-search.json, one row per
// footprint. The page filters every row per keystroke with no request, so a
// row carries what the picker shows and ranks on without a body loaded:
//
//   sym-index.json  { schema: 1, tag, fields: [lib, name, desc, keys, fp, pins, units, power], rows }
//   fp-search.json  { schema: 1, tag, fields: [lib, name, desc, tags, pads], rows }
//
// `lib` is the library nickname (no sym./fp. prefix). Rows are sorted by lib
// then name, both in code point order. Strings are KiCad's text decoded with
// its lexer rules; an absent field is the empty string, never null.
//
// A derived symbol takes desc, keys and fp from the nearest symbol up its
// extends chain that has them non-empty; units and power are the chain root's
// (KiCad's LIB_SYMBOL::GetUnitCount and IsPower ask the root of a derived
// symbol); pins counts the distinct pin numbers over every unit of every
// symbol of the chain.
import { compareNames } from './bundle.mjs';
import { childForms, decodeString, headAtoms, rootForm } from './kicad-symdir.mjs';

export const SYM_INDEX = 'sym-index.json';
export const FP_SEARCH = 'fp-search.json';
export const INDEX_SCHEMA = 1;
export const SYM_FIELDS = ['lib', 'name', 'desc', 'keys', 'fp', 'pins', 'units', 'power'];
export const FP_FIELDS = ['lib', 'name', 'desc', 'tags', 'pads'];

/** An atom's text as KiCad's lexer hands it over (quoted strings decoded). */
const atomText = (atom) => (atom.quoted ? decodeString(atom.text) : atom.text);

/**
 * The pin numbers one symbol pin number stands for. KiCad 10's stacked pin
 * notation (`[1,15,38,39]`, `[1-4]`, `[A1-A3,B7]`) is one graphical pin on
 * several pads; this expands it the way ExpandStackedPinNotation
 * (common/string_utils.cpp at the engine's pinned KiCad commit) does: a list
 * in brackets, each part a number or a range of numbers sharing a prefix. A
 * number that is not stacked, or a notation KiCad calls invalid, is itself.
 */
export function expandStackedPins(number) {
  if (!number.startsWith('[') || !number.endsWith(']') || number.length < 2) return [number];
  const out = [];
  for (const raw of number.slice(1, -1).split(',')) {
    const part = raw.trim();
    if (part === '') continue;
    const dash = part.indexOf('-');
    if (dash < 0) {
      out.push(part);
      continue;
    }
    const lo = splitPinNumber(part.slice(0, dash).trim());
    const hi = splitPinNumber(part.slice(dash + 1).trim());
    if (lo.prefix !== hi.prefix || lo.value < 0 || hi.value < 0 || lo.value > hi.value) return [number];
    for (let n = lo.value; n <= hi.value; n += 1) out.push(`${lo.prefix}${n}`);
  }
  return out.length > 0 ? out : [number];
}

/** ParseAlphaNumericPin: the text before a trailing run of digits, and that run's value (-1 when there is none). */
function splitPinNumber(text) {
  const m = /^(.*?)([0-9]+)$/s.exec(text);
  return m ? { prefix: m[1], value: Number(m[2]) } : { prefix: '', value: -1 };
}

/**
 * What one top-level `(symbol …)` block says about itself, inheritance aside:
 * its name and extends parent, its Description, ki_keywords and Footprint
 * properties (null when absent), whether it is a power symbol (`(power)`,
 * `(power global)` or `(power local)`), its unit count (the highest unit of
 * its `<name>_<unit>_<style>` sub-symbols, at least 1, as KiCad's parser
 * counts it) and the set of its pin numbers, stacked numbers expanded and an
 * empty number left out (it maps onto no pad).
 */
export function symbolFacts(block) {
  const top = headAtoms(block, 0);
  if (top[0]?.text !== 'symbol' || !top[1]) throw new Error('not a (symbol "<name>" …) block');
  const name = atomText(top[1]);
  const facts = { name, extends: null, desc: null, keys: null, fp: null, power: false, units: 1, pins: new Set() };
  const readPin = (at) => {
    for (const [s] of childForms(block, at)) {
      const atoms = headAtoms(block, s);
      if (atoms[0]?.text !== 'number' || atoms[0].quoted || !atoms[1]) continue;
      for (const n of expandStackedPins(atomText(atoms[1]))) if (n !== '') facts.pins.add(n);
    }
  };
  for (const [s] of childForms(block, 0)) {
    const atoms = headAtoms(block, s);
    if (!atoms[0] || atoms[0].quoted) continue;
    switch (atoms[0].text) {
      case 'extends':
        if (atoms[1]) facts.extends = atomText(atoms[1]);
        break;
      case 'power':
        facts.power = true;
        break;
      case 'property': {
        if (!atoms[1]) break;
        const value = atoms[2] ? atomText(atoms[2]) : '';
        const key = atomText(atoms[1]);
        if (key === 'Description') facts.desc = value;
        else if (key === 'ki_keywords') facts.keys = value;
        else if (key === 'Footprint') facts.fp = value;
        break;
      }
      case 'pin':
        readPin(s);
        break;
      case 'symbol': {
        // A sub-symbol: "<name>_<unit>_<body style>" (KiCad's parser refuses any other name).
        const sub = atoms[1] ? atomText(atoms[1]) : '';
        const parts = sub.startsWith(`${name}_`) ? sub.slice(name.length + 1).split('_') : [];
        if (parts.length === 2 && /^[+-]?[0-9]+$/.test(parts[0])) facts.units = Math.max(facts.units, Number(parts[0]));
        for (const [ps] of childForms(block, s)) {
          const head = headAtoms(block, ps)[0];
          if (head?.text === 'pin' && !head.quoted) readPin(ps);
        }
        break;
      }
      default:
        break;
    }
  }
  return facts;
}

/** A symbol's index row from the facts of its extends chain, root first and the symbol itself last. */
export function symbolRow(lib, chain) {
  const self = chain[chain.length - 1];
  const root = chain[0];
  const inherited = (key) => {
    for (let i = chain.length - 1; i >= 0; i -= 1) if (chain[i][key]) return chain[i][key];
    return '';
  };
  const pins = new Set();
  for (const f of chain) for (const p of f.pins) pins.add(p);
  return [lib, self.name, inherited('desc'), inherited('keys'), inherited('fp'), pins.size, root.units, root.power ? 1 : 0];
}

/** A footprint's `(descr …)` and `(tags …)`, empty when absent. */
export function footprintFacts(src) {
  const [open] = rootForm(src, ['footprint', 'module']);
  const facts = { desc: '', tags: '' };
  for (const [s] of childForms(src, open)) {
    const atoms = headAtoms(src, s);
    if (!atoms[0] || atoms[0].quoted) continue;
    if (atoms[0].text === 'descr') facts.desc = atoms[1] ? atomText(atoms[1]) : '';
    else if (atoms[0].text === 'tags') facts.tags = atoms[1] ? atomText(atoms[1]) : '';
  }
  return facts;
}

/** Rows sorted by lib then name, both in code point order (in place; returned). */
export function sortRows(rows) {
  return rows.sort((a, b) => compareNames(a[0], b[0]) || compareNames(a[1], b[1]));
}

/** The text of sym-index.json. */
export function symIndexText(tag, rows) {
  return JSON.stringify({ schema: INDEX_SCHEMA, tag, fields: SYM_FIELDS, rows: sortRows([...rows]) });
}

/** The text of fp-search.json. */
export function fpSearchText(tag, rows) {
  return JSON.stringify({ schema: INDEX_SCHEMA, tag, fields: FP_FIELDS, rows: sortRows([...rows]) });
}
