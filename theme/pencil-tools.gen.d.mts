// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Types for theme/pencil-tools.gen.mjs, so the strict typecheck can read its test.
export interface UnitRow { editor: string; strip: string; action: string; group?: string | null; section?: number; defaultKey?: string | null; press?: 'run'; label?: string }
export interface GenInputs { defaultsJson: string; layouts: { sch: string; pcb: string }; ledger: string; unitRows?: Array<{ unit: string; rows: UnitRow[] }>; extraHotkeys?: string; shadowed?: string[] }
/** `editor` is a table: sch, pcb, fpedit or ds (or a frame a unit defines); a row pressed by name carries `press: 'run'` and seededKey "". */
export interface GenRow { editor: string; strip: 'right' | 'top' | 'left'; action: string; group: string | null; section: number; defaultKey: string | null; seededKey: string | null; label: string; press?: 'run' }
export interface GenOutput { table: string; hotkeys: string; rows: GenRow[]; added: string[] }
export interface OffLayoutRow { editor: string; strip: 'right' | 'top' | 'left'; action: string; after?: string; group?: string; press?: 'run' }
export const TABLE_PATH: string;
export const HOTKEYS_PATH: string;
export const DEFAULTS_PATH: string;
export const LAYOUT_PATHS: { sch: string; pcb: string };
export const EDITORS: string[];
export const POOLS: Array<'sch' | 'pcb' | 'ds'>;
export function poolsOf(action: string): Array<'sch' | 'pcb' | 'ds'>;
export function pressable(key: string | null | undefined): boolean;
export const TOP_ACTIONS: Record<'sch' | 'pcb', string[]>;
export const OFF_LAYOUT: OffLayoutRow[];
export const POOL: string[];
export const BANNED: string[];
export const SHADOWED_DEFAULTS: string[];
export function generate(inputs: GenInputs): GenOutput;
export function readInputs(): GenInputs;
export const UNIT_ROWS_DIR: string;
export function readUnitRows(dir?: string): Array<{ unit: string; rows: UnitRow[] }>;
export const EXTRA_HOTKEYS_PATHS: string[];
export const UNIT_HOTKEYS_DIR: string;
export function readExtraHotkeys(): string;
