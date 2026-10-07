// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Types for scripts/libs/kicad-pretty.mjs, so the strict typecheck can read its tests.
export const FORK_MAX_BOARD_VERSION: number;
export function assertForkReads(version: number | null, where: string): void;
export function countUniquePads(src: string): number;
export function parseFootprintFile(src: string, name: string): { name: string; version: number | null; body: string };
