// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
export type Tool = 'pcbnew' | 'eeschema';
export type Frame = 'sch' | 'pcb';
export type Theme = 'day' | 'night';
export const frameToTool = (frame: Frame): Tool => (frame === 'pcb' ? 'pcbnew' : 'eeschema');
export const FRAME_TOKEN: Record<Frame, string> = { sch: 'sch', pcb: 'pcb' };   // the --frame= token single_top.cpp parses
