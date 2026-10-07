// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Types for scripts/libs/kicad-symdir.mjs, so the strict typecheck can read its tests.
export interface ParsedSymbol { name: string; extends: string | null; block: string }
export interface ParsedSymbolLib { header: string; version: number | null; symbols: ParsedSymbol[] }
export interface Atom { text: string; quoted: boolean }
export const FORK_MAX_SYMBOL_LIB_VERSION: number;
export function endOfString(src: string, i: number): number;
export function matchParen(src: string, open: number): [number, number];
export function childForms(src: string, open: number): Generator<[number, number]>;
export function headAtoms(src: string, open: number): Atom[];
export function decodeStringBytes(raw: string): Uint8Array;
export function decodeString(raw: string): string;
export function rootForm(src: string, heads: string[]): [number, number];
export function formVersion(src: string, open: number): number | null;
export function parseSymbolLib(src: string): ParsedSymbolLib;
export function libHeader(src: string): string;
export function assertForkReads(version: number | null, where: string): void;
export function resolveChain(byName: Map<string, ParsedSymbol>, sym: ParsedSymbol): ParsedSymbol[];
export function buildSelfContainedLib(header: string, parentBlocks: string[], primaryBlock: string): string;
