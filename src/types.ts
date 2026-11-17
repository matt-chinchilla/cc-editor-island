// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
export type Tool = 'pcbnew' | 'eeschema';
/** The frame's kind: the schematic editor, the board editor, or KiCad's symbol editor (island v0.2.3-cc23). */
export type Frame = 'sch' | 'pcb' | 'symedit';
export type Theme = 'day' | 'night';
export const frameToTool = (frame: Frame): Tool => (frame === 'pcb' ? 'pcbnew' : 'eeschema');
// The symbol editor is eeschema's SYMBOL_EDIT_FRAME (wx name LibeditFrame), booted by its own token.
export const FRAME_TOKEN: Record<Frame, string> = { sch: 'sch', pcb: 'pcb', symedit: 'symedit' };   // the --frame= token single_top.cpp parses
