// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// A small reader of KiCad's s-expressions, for the few files the island reads
// whole and small: a project's lib tables (project.libs) and one footprint's
// clipboard text (footprint.models reads its model lines back). Lists become
// arrays and atoms strings; a quoted atom is decoded with KiCad's lexer rules
// (symbol-body.ts decodeKicadString), so `"a\"b"` reads `a"b`. A whole symbol
// library is never read this way: symbol-body.ts slices it without a tree.
import { decodeKicadString } from '../loader/src/wasm/libs/symbol-body';

export type SNode = string | SNode[];

/**
 * The first list of `text` as a tree, or null when the text holds no list or
 * the list never closes (an unterminated string included). Text after the
 * first list is not read.
 */
export function readSexpr(text: string): SNode[] | null {
  const stack: SNode[][] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '(') {
      const list: SNode[] = [];
      stack[stack.length - 1]?.push(list);
      stack.push(list);
      i++;
      continue;
    }
    if (c === ')') {
      const done = stack.pop();
      if (done == null) return null;
      if (stack.length === 0) return done;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (stack.length === 0) { i++; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) return null;
      stack[stack.length - 1].push(decodeKicadString(text.slice(i + 1, j)));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !' \t\n\r()"'.includes(text[j])) j++;
    stack[stack.length - 1].push(text.slice(i, j));
    i = j;
  }
  return null;
}

/** A list's head atom (`lib` for `(lib (name "x"))`), or null. */
export const headOf = (n: SNode): string | null => (Array.isArray(n) && typeof n[0] === 'string' ? n[0] : null);

/** The child lists of `n` whose head is `head`, in order. */
export const listsOf = (n: SNode[], head: string): SNode[][] => n.filter((k): k is SNode[] => headOf(k) === head);

/** The first atom after the head of the first child list named `head` (`(name "x")` gives x), or null. */
export function valueOf(n: SNode[], head: string): string | null {
  const list = listsOf(n, head)[0];
  return list != null && typeof list[1] === 'string' ? list[1] : null;
}
