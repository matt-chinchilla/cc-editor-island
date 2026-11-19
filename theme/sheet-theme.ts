// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The drawing sheet editor's canvas color theme: the viewer's palette with the
// drawing sheet in a color that shows.
//
// The palette (theme/colors/circuitcenter.json) paints schematic.worksheet and
// schematic.page_limits transparent, so a schematic shows no page frame (KiCad
// has no setting for the schematic's sheet). KiCad's drawing sheet editor draws
// every line, rectangle, text and picture frame of a sheet in that one color
// (common/drawing_sheet/ds_painter.cpp, DS_RENDER_SETTINGS::LoadColors: the
// normal color is LAYER_SCHEMATIC_DRAWINGSHEET, which is schematic.worksheet):
// under the palette itself a sheet's items showed only while selected. This
// theme is seeded beside the palette and the ds frame's pl_editor.json selects
// it (bridge/ext/ds-i1.ts); the editors of a design keep the palette.

/** The theme's name: its file under the config's colors folder is `<name>.json`. */
export const SHEET_THEME = 'circuitcenter-sheet';

interface Theme {
  meta: { name: string; version: number };
  schematic: Record<string, unknown>;
  board: Record<string, unknown>;
}

/**
 * The sheet theme's JSON from the palette's: the same theme, key for key, but
 * the schematic's drawing sheet and page edge take the board's own (the
 * viewer's drawing sheet color, which the palette keeps there because a
 * board's sheet is hidden by its visibility setting, not by its color). A
 * text that does not read as a theme is returned as it is.
 */
export function sheetThemeOf(palette: string): string {
  let t: Theme;
  try {
    t = JSON.parse(palette) as Theme;
  } catch {
    return palette;
  }
  if (t == null || typeof t !== 'object' || t.schematic == null || t.board == null || t.meta == null) return palette;
  return JSON.stringify(
    {
      ...t,
      meta: { ...t.meta, name: 'Circuit Center sheet' },
      schematic: { ...t.schematic, worksheet: t.board.worksheet, page_limits: t.board.page_limits },
    },
    null,
    2,
  );
}
