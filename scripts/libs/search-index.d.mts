// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Types for scripts/libs/search-index.mjs, so the strict typecheck can read its tests.
export type SymRow = [lib: string, name: string, desc: string, keys: string, fp: string, pins: number, units: number, power: 0 | 1];
export type FpRow = [lib: string, name: string, desc: string, tags: string, pads: number];
export interface SymbolFacts {
  name: string;
  extends: string | null;
  desc: string | null;
  keys: string | null;
  fp: string | null;
  power: boolean;
  units: number;
  pins: Set<string>;
}
export const SYM_INDEX: string;
export const FP_SEARCH: string;
export const INDEX_SCHEMA: 1;
export const SYM_FIELDS: string[];
export const FP_FIELDS: string[];
export function expandStackedPins(number: string): string[];
export function symbolFacts(block: string): SymbolFacts;
export function symbolRow(lib: string, chain: SymbolFacts[]): SymRow;
export function footprintFacts(src: string): { desc: string; tags: string };
export function sortRows<T extends [string, string, ...unknown[]]>(rows: T[]): T[];
export function symIndexText(tag: string, rows: SymRow[]): string;
export function fpSearchText(tag: string, rows: FpRow[]): string;
