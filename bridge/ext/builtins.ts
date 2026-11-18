// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The names that ship without any wave unit: the request ops
// (bridge/ops.builtin.json), the export jobs (bridge/exports.builtin.json) and
// the event types (bridge/responder.ts IslandEvent). bridge/ops.json and
// bridge/exports.json are GENERATED from these plus every unit's file
// (npm run gen:ext); a unit never edits any of them.
import OPS from '../ops.builtin.json';
import JOBS from '../exports.builtin.json';

export const BUILTIN_OPS: readonly string[] = Object.freeze([...(OPS as string[])]);
export const BUILTIN_EXPORT_JOBS: Readonly<Record<string, 'pcb' | 'sch'>> = Object.freeze({ ...(JOBS as Record<string, 'pcb' | 'sch'>) });
/** Every event type the responder sends of its own (its emit switch; responder.test.ts checks the two agree). */
export const BUILTIN_EVENTS: readonly string[] = Object.freeze([
  'ev.state', 'ev.ready', 'ev.saved', 'ev.openTool', 'ev.help', 'ev.menu', 'ev.chrome', 'ev.edited', 'ev.pick', 'ev.selected',
  'ev.properties', 'ev.boardProperties', 'ev.held', 'ev.symedit', 'ev.key', 'ev.sim', 'ev.closing',
]);
