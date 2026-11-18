// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The frame registry: the three frames that ship (sch, pcb, symedit) and every
// frame a wave unit's file defines (bridge/ext/contract.ts FrameKind), read
// through one set of lookups so nothing else names a frame by hand: the boot
// token and tool (src/main.ts), the boot parse (src/cc-config.ts), KiCad's
// Switch items (frameForTool), the document kind and extension, the drawing's
// units, the picker, and the ops a frame refuses (bridge/responder.ts).
import { REGISTRY, type Registry } from '../bridge/ext/registry';
import type { FrameKind, ToolKind } from '../bridge/ext/contract';
import { FRAME_TOKEN, frameToTool, isBuiltinFrame, type BuiltinTool, type Frame, type Tool } from './types';

const BUILTIN_DOCUMENT: Readonly<Record<string, string | null>> = { sch: '.kicad_sch', pcb: '.kicad_pcb', symedit: null };
const BUILTIN_EXTENSION: Readonly<Record<string, string>> = { sch: '.kicad_sch', pcb: '.kicad_pcb', symedit: '.kicad_sym' };
const BUILTIN_UNITS: Readonly<Record<string, number>> = { sch: 1e4, pcb: 1e6, symedit: 1e4 };

/** A frame a unit defined, or null for a built in frame or no frame at all. */
export function frameKind(frame: string, reg: Registry = REGISTRY): FrameKind | null {
  return reg.frames.get(frame)?.kind ?? null;
}

/** Every frame name: the built ins, then the units' in name order. */
export function frameNames(reg: Registry = REGISTRY): Frame[] {
  return ['sch', 'pcb', 'symedit', ...[...reg.frames.keys()].sort()] as Frame[];
}

/** The boot query's frame: a known frame name, else sch (src/cc-config.ts parseBoot). */
export function bootFrame(raw: string | null, reg: Registry = REGISTRY): Frame {
  if (raw === 'pcb' || raw === 'symedit') return raw;
  if (raw != null && reg.frames.has(raw)) return raw as Frame;
  return 'sch';
}

/** The --frame= token single_top.cpp parses. */
export function frameToken(frame: Frame, reg: Registry = REGISTRY): string {
  return isBuiltinFrame(frame) ? FRAME_TOKEN[frame] : (frameKind(frame, reg)?.token ?? frame);
}

/** The tool a frame boots (a built in tool's name or a unit's own). */
export function frameTool(frame: Frame, reg: Registry = REGISTRY): Tool {
  if (isBuiltinFrame(frame)) return frameToTool(frame);
  const tool = frameKind(frame, reg)?.tool;
  if (tool == null) return 'eeschema';
  return (typeof tool === 'string' ? tool : tool.name) as Tool;
}

/** A unit's own tool descriptor by name (loader/src/wasm/constants.ts reads it), null for a built in tool. */
export function extTool(name: string, reg: Registry = REGISTRY): ToolKind | null {
  for (const { kind } of reg.frames.values()) if (typeof kind.tool !== 'string' && kind.tool.name === name) return kind.tool;
  return null;
}

/** kicadWebOpenTool's name (a path, with .exe sometimes) as a frame: pcbnew and eeschema, and each unit frame's toolNames. */
export function frameForToolName(raw: string, reg: Registry = REGISTRY): Frame | null {
  const base = (raw.replace(/\\/g, '/').split('/').pop() ?? raw).replace(/\.exe$/i, '');
  if (base === 'pcbnew') return 'pcb';
  if (base === 'eeschema') return 'sch';
  for (const [name, { kind }] of reg.frames) if ((kind.toolNames ?? []).includes(base)) return name as Frame;
  return null;
}

/** The document kind project.write refuses in a frame (lowercased extension), null for none. */
export function ownDocument(frame: Frame, reg: Registry = REGISTRY): string | null {
  if (isBuiltinFrame(frame)) return BUILTIN_DOCUMENT[frame] ?? null;
  return frameKind(frame, reg)?.document ?? null;
}

/** The extension of the file a frame opens. */
export function documentExtension(frame: Frame, reg: Registry = REGISTRY): string {
  if (isBuiltinFrame(frame)) return BUILTIN_EXTENSION[frame];
  return frameKind(frame, reg)?.extension ?? '';
}

/** The drawing's internal units per millimeter. */
export function unitsPerMm(frame: Frame, reg: Registry = REGISTRY): number {
  if (isBuiltinFrame(frame)) return BUILTIN_UNITS[frame];
  return frameKind(frame, reg)?.unitsPerMm ?? 1e6;
}

/** Whether a frame places through the host's picker and warms the library (symedit and every frame that says so do not). */
export function framePicks(frame: Frame, reg: Registry = REGISTRY): boolean {
  if (isBuiltinFrame(frame)) return frame !== 'symedit';
  return frameKind(frame, reg)?.picker === true;
}

/** The refusal a unit frame answers for a built in op it does not run, or null. */
export function frameRefusal(frame: Frame, op: string, reg: Registry = REGISTRY): string | null {
  const kind = isBuiltinFrame(frame) ? null : frameKind(frame, reg);
  return kind != null && kind.refuses.includes(op) ? kind.refusal : null;
}

/** A built in tool's name, for the loader's tables. */
export const isBuiltinTool = (tool: string): tool is BuiltinTool => tool === 'pcbnew' || tool === 'eeschema';
