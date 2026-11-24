// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The drawing sheet editor's frame (spec "The Drawing Sheet Editor", section
// 6): KiCad's own PL_EDITOR_FRAME booted with ?frame=ds in the merged editor
// image (engine run 15), canvas only. This unit defines the frame (its tool,
// its refusals, the caps it lists, its selection and undo depth reads), the
// ops dsedit.open, dsedit.state, dsedit.take, dsedit.markSaved and
// dsedit.show, select in a ds frame, and the frame's actions held for the
// host. Every op is feature detected on the engine's dsedit exports: on an
// engine without them a ds frame lists no dsedit cap and each op answers
// unsupported naming the first missing export.
import { BUILTIN_OPS } from './builtins';
import { hasAll, type ExtUnit } from './contract';
import {
  DS_FRAME, DS_FRAME_ONLY, DS_HELD, DS_REFUSAL, DS_WORKS, DSEDIT_CAP, DSEDIT_EXPORTS,
  dsMarkSaved, dsOpen, dsSelect, dsSelectionRead, dsSheetOpen, dsShow, dsState, dsTake, dsUndoDepth,
} from '../dsedit';
import { SHEET_THEME } from '../../theme/sheet-theme';

declare module '../../src/types' {
  interface ExtFrames { ds: true }
  interface ExtTools { pl_editor: true }
}

export default {
  unit: 'ds-i1',
  frames: [DS_FRAME],
  frameRefusal: DS_FRAME_ONLY,
  ops: {
    'dsedit.open': { run: dsOpen },
    'dsedit.state': { run: dsState },
    'dsedit.take': { run: dsTake },
    'dsedit.markSaved': { run: dsMarkSaved },
    'dsedit.show': { run: dsShow },
  },
  // select in a ds frame selects the sheet's own items (kicadDsEditSelect); every other frame keeps select as it ships.
  opsWidened: { select: (args, ctx, next) => (ctx.frame === DS_FRAME ? dsSelect(args, ctx) : next(args)) },
  capNames: [DSEDIT_CAP],
  caps: (mod, frame) => (frame === DS_FRAME && hasAll(mod, DSEDIT_EXPORTS) ? [DSEDIT_CAP] : []),
  held: DS_HELD,
  heldRows: DS_HELD.map((action) => ({ action, frames: [DS_FRAME], cap: DSEDIT_CAP })),
  defineFrames: {
    ds: {
      token: 'ds',
      // pl_editor reads its own pl_editor.json: seeded with the viewer's appearance, the frame draws in the viewer's palette,
      // but for the drawing sheet's own color: the palette makes it transparent (no page frame on a schematic) and it is the
      // color every item of a sheet is drawn in here, so the frame selects the sheet theme (theme/sheet-theme.ts).
      tool: { name: 'pl_editor', bundle: 'kicad_editor', argv0: '/usr/bin/pl_editor', needsConfigSeed: true, libKind: null, appearanceFiles: ['pl_editor.json'], colorTheme: SHEET_THEME },
      // A drawing sheet holds no document: project.write is refused whole (below), so no kind of its own.
      document: null,
      extension: '.kicad_wks',
      // KiCad's drawing sheet scale: 1,000 internal units per millimeter.
      unitsPerMm: 1e3,
      pickKind: 'symbol',
      picker: false,
      refuses: BUILTIN_OPS.filter((op) => !DS_WORKS.includes(op)),
      refusal: DS_REFUSAL,
      // Of the built in pseudo-caps only the held keys and the host's keys; dsedit is this unit's own.
      caps: ['heldKeys', 'hostKeys', 'observeKeys'],
      selection: { read: (mod) => dsSelectionRead(mod), live: (ctx) => dsSheetOpen(ctx.mod()) },
      documentOpen: (mod) => dsSheetOpen(mod),
      undoDepth: (mod) => dsUndoDepth(mod),
    },
  },
} satisfies ExtUnit;
