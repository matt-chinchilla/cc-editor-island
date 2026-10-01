// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Types for theme/pencil-tools.gen.mjs, so the strict typecheck can read its test.
export interface GenInputs { defaultsJson: string; layouts: { sch: string; pcb: string }; ledger: string }
export interface GenRow { editor: 'sch' | 'pcb'; strip: 'right' | 'top' | 'left'; action: string; group: string | null; section: number; defaultKey: string | null; seededKey: string | null; label: string }
export interface GenOutput { table: string; hotkeys: string; rows: GenRow[]; added: string[] }
export const TABLE_PATH: string;
export const HOTKEYS_PATH: string;
export const DEFAULTS_PATH: string;
export const LAYOUT_PATHS: { sch: string; pcb: string };
export const TOP_ACTIONS: Record<'sch' | 'pcb', string[]>;
export const OFF_LAYOUT: { pcb: { action: string; after: string } };
export const POOL: string[];
export const BANNED: string[];
export function generate(inputs: GenInputs): GenOutput;
export function readInputs(): GenInputs;
