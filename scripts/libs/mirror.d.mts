// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Types for scripts/libs/mirror.mjs, so the strict typecheck can read its tests.
import type { Kind } from './bundle.mjs';
export interface ManifestLib { id: string; name: string; kind: Kind; itemCount: number; bytes: number; description?: string }
export interface KindFigures { libs: number; items: number; bytes: number }
export interface MirrorFigures {
  tag: string;
  symbol: KindFigures;
  footprint: KindFigures;
  biggest: { id: string; bytes: number; raw: number; items: number }[];
  sumsSha256: string;
}
export interface BuildOptions {
  symbolsSrc: string;
  footprintsSrc: string;
  out: string;
  tag: string;
  only?: string[] | null;
  provenance?: { symbols: string; footprints: string };
  log?: (line: string) => void;
  concurrency?: number;
}
export interface Built { dir: string; libs: ManifestLib[]; raw: Record<string, number>; skipped: string[]; sumsSha256: string }
export const SCHEMA: 1;
export const MANIFEST: string;
export const FP_INDEX: string;
export const LICENSE: string;
export const SUMS: string;
export function bundleName(id: string): string;
export function gz(buf: Uint8Array): Promise<Uint8Array>;
export function buildMirror(opts: BuildOptions): Promise<Built>;
export function verifyMirror(dir: string): MirrorFigures;
