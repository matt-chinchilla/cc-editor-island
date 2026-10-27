// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { modelsJson, parseModelsArgs, readModels, sameModels } from './models';

const UUID = '00000000-0000-0000-0000-00005be41647';
/** Glasgow's C30 as the engine's kicadCollabTestItemBlob gives it, cut short (measured 2026-10-27). */
const C30 = `(footprint "Capacitor_SMD:C_0402_1005Metric"
\t(layer "F.Cu")
\t(uuid "${UUID}")
\t(at 127 107.6 90)
\t(property "Reference" "C30" (at 0 0 90) (layer "F.SilkS"))
\t(pad "1" smd roundrect (at -0.485 0 90) (size 0.59 0.64) (layers "F.Cu" "F.Paste" "F.Mask"))
\t(model "\${KICAD6_3DMODEL_DIR}/Capacitor_SMD.3dshapes/C_0402_1005Metric.step"
\t\t(offset (xyz 0 0 0))
\t\t(scale (xyz 1 1 1))
\t\t(rotate (xyz 0 0 0))
\t)
\t(model "\${KIPRJMOD}/glasgow_parts.3dshapes/C30 \\"cap\\".wrl"
\t\t(offset (xyz 0.1 -0.25 0.5))
\t\t(scale (xyz 0.3937 0.3937 0.3937))
\t\t(rotate (xyz -90 0 180))
\t)
)`;

describe('footprint.models args', () => {
  it('takes a uuid and 0 to 64 models, offset, rotate and scale defaulting to KiCad\'s own', () => {
    expect(parseModelsArgs({ uuid: UUID, models: [] })).toEqual({ uuid: UUID, models: [] });
    expect(parseModelsArgs({ uuid: UUID, models: [{ path: '${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.step' }] })).toEqual({
      uuid: UUID,
      models: [{ path: '${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.step', offset: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] }],
    });
    expect(parseModelsArgs({ uuid: UUID, models: [{ path: 'a.step', offset: [1, -2, 0.5], rotate: [-90, 0, 180], scale: [0.3937, 0.3937, 0.3937] }] })?.models[0])
      .toEqual({ path: 'a.step', offset: [1, -2, 0.5], rotate: [-90, 0, 180], scale: [0.3937, 0.3937, 0.3937] });
    expect(parseModelsArgs({ uuid: UUID, models: Array.from({ length: 64 }, () => ({ path: 'a.step' })) })?.models).toHaveLength(64);
  });

  it('refuses anything else', () => {
    const m = { path: 'a.step' };
    for (const args of [
      undefined, {}, { uuid: UUID }, { models: [] }, { uuid: UUID, models: [], extra: 1 },
      { uuid: UUID.toUpperCase(), models: [] }, { uuid: 'C30', models: [] }, { uuid: `/${UUID}`, models: [] },
      { uuid: UUID, models: m }, { uuid: UUID, models: Array.from({ length: 65 }, () => m) },
      { uuid: UUID, models: [{ path: '' }] }, { uuid: UUID, models: [{ path: 'x'.repeat(1025) }] }, { uuid: UUID, models: [{ path: 'a\nb.step' }] },
      { uuid: UUID, models: [{ path: 5 }] }, { uuid: UUID, models: [{ path: 'a.step', hide: true }] },
      { uuid: UUID, models: [{ path: 'a.step', offset: [0, 0] }] }, { uuid: UUID, models: [{ path: 'a.step', scale: [1, 1, '1'] }] },
      { uuid: UUID, models: [{ path: 'a.step', rotate: [0, 0, Infinity] }] }, { uuid: UUID, models: [{ path: 'a.step', offset: [10_001, 0, 0] }] },
      { uuid: UUID, models: [{ path: 'a.step', offset: { x: 0, y: 0, z: 0 } }] },
    ]) expect(parseModelsArgs(args)).toBeNull();
  });

  it('hands the engine a JSON array with every field', () => {
    expect(JSON.parse(modelsJson([{ path: 'a.step', offset: [1, 2, 3], rotate: [0, 0, 90], scale: [1, 1, 1] }])))
      .toEqual([{ path: 'a.step', offset: [1, 2, 3], rotate: [0, 0, 90], scale: [1, 1, 1] }]);
  });
});

describe('reading a footprint\'s model lines back', () => {
  it('reads each model line in order, its path decoded', () => {
    expect(readModels(C30)).toEqual([
      { path: '${KICAD6_3DMODEL_DIR}/Capacitor_SMD.3dshapes/C_0402_1005Metric.step', offset: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
      { path: '${KIPRJMOD}/glasgow_parts.3dshapes/C30 "cap".wrl', offset: [0.1, -0.25, 0.5], rotate: [-90, 0, 180], scale: [0.3937, 0.3937, 0.3937] },
    ]);
    expect(readModels('(footprint "x" (layer "F.Cu"))')).toEqual([]);
    expect(readModels('(footprint "x" (model "a.step" (offset (xyz 1 2 3))))')?.[0]).toEqual({ path: 'a.step', offset: [1, 2, 3], rotate: [0, 0, 0], scale: [1, 1, 1] });
    expect(readModels('')).toBeNull();
    expect(readModels('(segment (start 0 0))')).toBeNull();
    expect(readModels('(footprint "x"')).toBeNull();
  });

  it('compares the lines read with the models sent, numbers within KiCad\'s short writing', () => {
    const sent = [{ path: 'a.step', offset: [0.1, 0, 0] as [number, number, number], rotate: [0, 0, 1 / 3] as [number, number, number], scale: [1, 1, 1] as [number, number, number] }];
    expect(sameModels(readModels('(footprint "x" (model "a.step" (offset (xyz 0.1 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0.3333333333))))')!, sent)).toBe(true);
    expect(sameModels(readModels('(footprint "x" (model "a.step" (offset (xyz 0.11 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0.3333333333))))')!, sent)).toBe(false);
    expect(sameModels(readModels('(footprint "x" (model "b.step"))')!, sent)).toBe(false);
    expect(sameModels([], [])).toBe(true);
    expect(sameModels(readModels(C30)!, [])).toBe(false);
  });
});
