// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
/** The engine tools the island boots out of the box. */
export type BuiltinTool = 'pcbnew' | 'eeschema';
/**
 * The tools a unit's file adds (bridge/ext/README.md), by declaration merging:
 * `declare module '../../src/types' { interface ExtTools { pl_editor: true } }`.
 * Its boot row comes from the unit's frame descriptor (src/frames.ts).
 */
export interface ExtTools {}
export type Tool = BuiltinTool | Extract<keyof ExtTools, string>;
/** The frames the island boots out of the box: the schematic editor, the board editor, or KiCad's symbol editor (island v0.2.3-cc23). */
export type BuiltinFrame = 'sch' | 'pcb' | 'symedit';
/**
 * The frames a unit's file adds (the footprint editor fpedit, the drawing sheet
 * editor ds), by declaration merging as ExtTools; each with its descriptor in
 * the unit's `defineFrames` (bridge/ext/contract.ts FrameKind).
 */
export interface ExtFrames {}
/** The frame's kind: a built in one, or one a unit's file added. */
export type Frame = BuiltinFrame | Extract<keyof ExtFrames, string>;
export type Theme = 'day' | 'night';
export const BUILTIN_FRAMES: readonly BuiltinFrame[] = Object.freeze(['sch', 'pcb', 'symedit']);
export const isBuiltinFrame = (frame: string): frame is BuiltinFrame => (BUILTIN_FRAMES as readonly string[]).includes(frame);
/** A built in frame's tool; src/frames.ts frameTool answers for every frame. */
export const frameToTool = (frame: BuiltinFrame): BuiltinTool => (frame === 'pcb' ? 'pcbnew' : 'eeschema');
// The symbol editor is eeschema's SYMBOL_EDIT_FRAME (wx name LibeditFrame), booted by its own token.
export const FRAME_TOKEN: Record<BuiltinFrame, string> = { sch: 'sch', pcb: 'pcb', symedit: 'symedit' };   // the --frame= token single_top.cpp parses
