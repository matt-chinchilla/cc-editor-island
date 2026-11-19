// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-open-foreign-i: project.import's format is authoritative in a sch frame.
// The widening lives in bridge/import.ts, the bridge file the import units own
// (schematicType, read by importCall, which the responder hands `format`); this
// file records the unit in the registry and adds no op, cap or event.
import type { ExtUnit } from './contract';

export default {
  unit: 'st-open-foreign-i',
} satisfies ExtUnit;
