// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The drawing sheet editor's items, defaults, preview, append and picture ops
// (spec "The Drawing Sheet Editor", section 6.2): dsedit.items.get, .set, .add
// and .remove, dsedit.defaults.get and .set, dsedit.preview.get and .set,
// dsedit.append and dsedit.image.arm in a ds frame (ds-i1 defines it), and
// ev.dsedit, KiCad's Place Bitmaps asking the page for a picture with no
// dialog. Every op passes ds-i1's gate (feature detected on the engine's dsedit
// exports: on an engine without them each op answers unsupported naming the
// first missing export). The cap dseditHeld is listed in a ds frame when the
// engine has every dsedit export and asks the page (kicadHostDsEdit).
import { hasAll, type ExtUnit } from './contract';
import { DS_FRAME, DS_FRAME_ONLY, DSEDIT_EXPORTS } from '../dsedit';
import {
  DSEDIT_ASK_EXPORT, DSEDIT_EVENT, DSEDIT_EVENT_KEYS, DSEDIT_HELD_CAP, installDsEditAsk, type DsEditAskWindow,
  dsAppend, dsDefaultsGet, dsDefaultsSet, dsImageArm, dsItemsAdd, dsItemsGet, dsItemsRemove, dsItemsSet, dsPreviewGet, dsPreviewSet,
} from '../dseditItems';

/** What the ask needs of the engine: every dsedit export and the marker. */
const ASK_EXPORTS = [...DSEDIT_EXPORTS, DSEDIT_ASK_EXPORT] as const;

export default {
  unit: 'ds-i2',
  frames: [DS_FRAME],
  frameRefusal: DS_FRAME_ONLY,
  ops: {
    'dsedit.items.get': { run: dsItemsGet },
    'dsedit.items.set': { run: dsItemsSet },
    'dsedit.items.add': { run: dsItemsAdd },
    'dsedit.items.remove': { run: dsItemsRemove },
    'dsedit.defaults.get': { run: dsDefaultsGet },
    'dsedit.defaults.set': { run: dsDefaultsSet },
    'dsedit.preview.get': { run: dsPreviewGet },
    'dsedit.preview.set': { run: dsPreviewSet },
    'dsedit.append': { run: dsAppend },
    'dsedit.image.arm': { run: dsImageArm },
  },
  capNames: [DSEDIT_HELD_CAP],
  caps: (mod, frame) => (frame === DS_FRAME && hasAll(mod, ASK_EXPORTS) ? [DSEDIT_HELD_CAP] : []),
  events: { [DSEDIT_EVENT]: DSEDIT_EVENT_KEYS },
  // KiCad's Place Bitmaps with nothing armed asks the page (ev.dsedit), once per request,
  // after ev.ready while a sheet is open; it places nothing and opens no window.
  install(ctx) {
    const w = ctx.win();
    if (ctx.frame !== DS_FRAME || w == null || !hasAll(ctx.mod(), ASK_EXPORTS)) return undefined;
    return installDsEditAsk(w as unknown as DsEditAskWindow, {
      admit: () => ctx.admit(),
      send: (a) => ctx.emitExt(DSEDIT_EVENT, { ask: a.ask, uuid: a.uuid, isNew: a.isNew }),
    });
  },
} satisfies ExtUnit;
