// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Types for scripts/libs/bundle.mjs, so the strict typecheck can read its tests.
export type Kind = 'symbol' | 'footprint';
export interface DecodedBundle { v: 2; id: string; kind: Kind; items: { name: string; body: Uint8Array }[] }
export const BUNDLE_VERSION: 2;
export const KINDS: Kind[];
export function compareNames(a: string, b: string): number;
export function encodeBundle(bundle: { id: string; kind: Kind; items: [string, string | Uint8Array][] }): Uint8Array;
export function decodeBundle(buf: Uint8Array): DecodedBundle;
