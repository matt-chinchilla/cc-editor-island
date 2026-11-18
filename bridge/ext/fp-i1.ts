// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The footprint editor's frame (spec "The Footprint Editor", section 6): KiCad's
// own FOOTPRINT_EDIT_FRAME booted with ?frame=fpedit in pcbnew (engine run
// 15), canvas only. This unit defines the frame (its tool, its refusals, the
// built in caps it lists, its selection and undo depth reads), the ops
// fpedit.open, fpedit.new, fpedit.state, fpedit.take and fpedit.markSaved,
// and select in an fpedit frame. Every op is feature detected on the engine's
// fpedit exports: on an engine without them an fpedit frame lists no fpedit
// cap and each op answers unsupported naming the first missing export.
// The frame's held actions and its asks are fp-i2b's; its other ops fp-i2a's,
// fp-i2b's and fp-i3's, through fpEditGate (bridge/fpedit/common.ts).
import { BUILTIN_OPS } from './builtins';
import { hasAll, type ExtUnit } from './contract';
import {
  FPEDIT_CAP, FPEDIT_EXPORTS, FPEDIT_FRAME, FPEDIT_FRAME_ONLY, FPEDIT_PSEUDO_CAPS, FPEDIT_REFUSAL, FPEDIT_WORKS,
  fpFootprintOpen, fpMarkSaved, fpNew, fpOpen, fpSelect, fpSelectionRead, fpState, fpTake, fpUndoDepth,
} from '../fpedit/common';

declare module '../../src/types' {
  interface ExtFrames { fpedit: true }
}

export default {
  unit: 'fp-i1',
  frames: [FPEDIT_FRAME],
  frameRefusal: FPEDIT_FRAME_ONLY,
  ops: {
    'fpedit.open': { run: fpOpen },
    'fpedit.new': { run: fpNew },
    'fpedit.state': { run: fpState },
    'fpedit.take': { run: fpTake },
    'fpedit.markSaved': { run: fpMarkSaved },
  },
  // select in an fpedit frame selects the footprint's own items (kicadFpEditSelect); every other frame keeps select as it ships.
  opsWidened: { select: (args, ctx, next) => ((ctx.frame as string) === FPEDIT_FRAME ? fpSelect(args, ctx) : next(args)) },
  capNames: [FPEDIT_CAP],
  caps: (mod, frame) => ((frame as string) === FPEDIT_FRAME && hasAll(mod, FPEDIT_EXPORTS) ? [FPEDIT_CAP] : []),
  defineFrames: {
    fpedit: {
      token: 'fpedit',
      // KiCad's footprint editor is a frame of pcbnew: the same kiface, booted by its own token.
      tool: 'pcbnew',
      // A footprint editor holds no document of the project's: project.write refuses no kind of file there.
      document: null,
      extension: '.kicad_mod',
      // pcbnew's internal units: 1,000,000 per millimeter.
      unitsPerMm: 1e6,
      pickKind: 'footprint',
      // No picker warm up: a footprint editor places pads and drawings, never a part.
      picker: false,
      refuses: BUILTIN_OPS.filter((op) => !FPEDIT_WORKS.includes(op)),
      refusal: FPEDIT_REFUSAL,
      // Of the built in pseudo-caps only the held keys, the host's keys, project.write and
      // project.libs; fpedit is this unit's own, the others other units' (fpeditHeld,
      // footprintConvert, importGraphics).
      caps: FPEDIT_PSEUDO_CAPS,
      selection: { read: (mod) => fpSelectionRead(mod), live: (ctx) => fpFootprintOpen(ctx.mod()) },
      documentOpen: (mod) => fpFootprintOpen(mod),
      undoDepth: (mod) => fpUndoDepth(mod),
    },
  },
} satisfies ExtUnit;
