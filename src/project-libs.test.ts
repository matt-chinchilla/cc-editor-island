// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it, vi } from 'vitest';
import { createProjectLibs, isBuiltinPathVar, isProjectNick, parseLibTable, projectId, projectLibsAt, projectPath, readPathVars, rowPath, withProjectLibs, type ProjectFs } from './project-libs';
import { readSexpr, valueOf } from './sexpr';
import type { LibsSource } from '../loader/src/wasm/libs/source';

const ROOT = '/p/cc';
const enc = new TextEncoder();

/** A folder of files by absolute path; folders are implied by the files under them. */
function fakeFs(files: Record<string, string>): ProjectFs & { files: Map<string, string> } {
  const map = new Map(Object.entries(files));
  const isDirPath = (p: string) => [...map.keys()].some((k) => k.startsWith(`${p}/`));
  return {
    files: map,
    readFile: (p: string) => { const t = map.get(p); if (t == null) throw new Error(`ENOENT ${p}`); return enc.encode(t); },
    readdir: (p: string) => ['.', '..', ...new Set([...map.keys()].filter((k) => k.startsWith(`${p}/`)).map((k) => k.slice(p.length + 1).split('/')[0]))],
    analyzePath: (p: string) => ({ exists: map.has(p) || isDirPath(p) }),
    stat: (p: string) => ({ mode: isDirPath(p) ? 0o040755 : 0o100644 }),
    isDir: (mode: number) => (mode & 0o170000) === 0o040000,
  };
}

const SYM_TABLE = `(sym_lib_table
  (version 7)
  (lib (name "Device")(type "KiCad")(uri "\${KICAD10_SYMBOL_DIR}/Device.kicad_sym")(options "")(descr ""))
  (lib (name "glasgow_parts")(type "KiCad")(uri "\${KIPRJMOD}/glasgow_parts.kicad_sym")(options "")(descr ""))
)
`;
const FP_TABLE = `(fp_lib_table
  (version 7)
  (lib (name "glasgow_parts")(type "KiCad")(uri "\${KIPRJMOD}/glasgow_parts.pretty")(options "")(descr ""))
)
`;
const SYMS = `(kicad_symbol_lib
\t(version 20241209)
\t(generator "kicad_symbol_editor")
\t(symbol "BASE" (in_bom yes) (on_board yes)
\t\t(property "Reference" "U" (at 0 0 0))
\t\t(symbol "BASE_1_1" (pin passive line (at 0 0 0) (length 1) (name "A") (number "1"))))
\t(symbol "ST25DV04K" (extends "BASE")
\t\t(property "Value" "ST25DV04K" (at 0 0 0)))
\t(symbol "R \\"quoted\\"" (in_bom yes))
)
`;
const FP = '(footprint "UFDFPN8" (version 20241229) (layer "F.Cu") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))';

function folder(extra: Record<string, string> = {}) {
  return fakeFs({
    [`${ROOT}/sym-lib-table`]: SYM_TABLE,
    [`${ROOT}/fp-lib-table`]: FP_TABLE,
    [`${ROOT}/glasgow_parts.kicad_sym`]: SYMS,
    [`${ROOT}/glasgow_parts.pretty/UFDFPN8.kicad_mod`]: FP,
    [`${ROOT}/glasgow_parts.pretty/notes.txt`]: 'not a footprint',
    ...extra,
  });
}

describe('the s-expression reader', () => {
  it('reads lists and atoms, quoted ones decoded with KiCad\'s rules, and refuses an unbalanced text', () => {
    expect(readSexpr('(a "b \\"c\\"" (d 1.5) e)')).toEqual(['a', 'b "c"', ['d', '1.5'], 'e']);
    expect(readSexpr('  (x (y "(not a list)"))  trailing')).toEqual(['x', ['y', '(not a list)']]);
    expect(readSexpr('(a (b)')).toBeNull();
    expect(readSexpr('(a "open)')).toBeNull();
    expect(readSexpr('no list')).toBeNull();
    expect(valueOf(['lib', ['name', 'x'], ['uri', 'y']], 'uri')).toBe('y');
  });
});

describe('lib tables', () => {
  it('reads every row of a table of its kind, and nothing of the other kind\'s table', () => {
    expect(parseLibTable(SYM_TABLE, 'symbol')).toEqual([
      { name: 'Device', type: 'KiCad', uri: '${KICAD10_SYMBOL_DIR}/Device.kicad_sym' },
      { name: 'glasgow_parts', type: 'KiCad', uri: '${KIPRJMOD}/glasgow_parts.kicad_sym' },
    ]);
    expect(parseLibTable(SYM_TABLE, 'footprint')).toEqual([]);
    // Bare atoms read as quoted ones (older tables wrote some unquoted).
    expect(parseLibTable('(fp_lib_table (lib (name p)(type KiCad)(uri ${KIPRJMOD}/p.pretty)))', 'footprint')).toEqual([{ name: 'p', type: 'KiCad', uri: '${KIPRJMOD}/p.pretty' }]);
    expect(parseLibTable('garbage', 'symbol')).toEqual([]);
  });

  it('takes a KiCad row of a ${KIPRJMOD} path in its normal form, ending in the kind\'s extension, and nothing else', () => {
    const row = (type: string, uri: string) => ({ name: 'n', type, uri });
    expect(projectPath(row('KiCad', '${KIPRJMOD}/glasgow_parts.kicad_sym'), 'symbol')).toBe('glasgow_parts.kicad_sym');
    expect(projectPath(row('kicad', '${KIPRJMOD}/libs/parts.pretty'), 'footprint')).toBe('libs/parts.pretty');
    for (const [type, uri, kind] of [
      ['Legacy', '${KIPRJMOD}/a.kicad_sym', 'symbol'],
      ['KiCad', '${KICAD10_SYMBOL_DIR}/Device.kicad_sym', 'symbol'],
      ['KiCad', '$(KIPRJMOD)/a.kicad_sym', 'symbol'],
      ['KiCad', '${KIPRJMOD}/../a.kicad_sym', 'symbol'],
      ['KiCad', '${KIPRJMOD}//a.kicad_sym', 'symbol'],
      ['KiCad', '${KIPRJMOD}/a.pretty', 'symbol'],
      ['KiCad', '${KIPRJMOD}/a.kicad_sym', 'footprint'],
      ['KiCad', '${KIPRJMOD}/.pretty', 'footprint'],
    ] as const) expect(projectPath(row(type, uri), kind)).toBeNull();
  });

  it('a project nickname has no control character and none of / \\ :', () => {
    expect(isProjectNick('glasgow_parts')).toBe(true);
    for (const n of ['', 'a/b', 'a\\b', 'a:b', 'a\nb', 'x'.repeat(256), 3]) expect(isProjectNick(n)).toBe(false);
  });
});

describe('the project libraries', () => {
  it('finds a nickname in each table that names it as a project library whose file or folder is there', () => {
    const fs = folder();
    const libs = createProjectLibs({ root: ROOT, fs: () => fs });
    expect(libs.find('glasgow_parts')).toEqual([
      { kind: 'symbol', nick: 'glasgow_parts', path: 'glasgow_parts.kicad_sym', id: 'prj.sym.glasgow_parts' },
      { kind: 'footprint', nick: 'glasgow_parts', path: 'glasgow_parts.pretty', id: 'prj.fp.glasgow_parts' },
    ]);
    // A global row of the project's table, an unknown name, a missing file.
    expect(libs.find('Device')).toEqual([]);
    expect(libs.find('other')).toEqual([]);
    fs.files.delete(`${ROOT}/glasgow_parts.kicad_sym`);
    expect(libs.find('glasgow_parts').map((l) => l.kind)).toEqual(['footprint']);
    // No file system yet (before boot): nothing.
    expect(createProjectLibs({ root: ROOT, fs: () => null }).find('glasgow_parts')).toEqual([]);
  });

  it('reads the tables beside the project file, ${KIPRJMOD}, and takes each row\'s path from there', () => {
    const sub = 'Hardware/Main-board';
    const fs = fakeFs({
      [`${ROOT}/${sub}/sym-lib-table`]: SYM_TABLE,
      [`${ROOT}/${sub}/fp-lib-table`]: FP_TABLE,
      [`${ROOT}/${sub}/glasgow_parts.kicad_sym`]: SYMS,
      [`${ROOT}/${sub}/glasgow_parts.pretty/UFDFPN8.kicad_mod`]: FP,
      // Tables at the root name nothing for a project whose file sits in the subfolder.
      [`${ROOT}/fp-lib-table`]: FP_TABLE,
    });
    const libs = createProjectLibs({ root: ROOT, fs: () => fs });
    expect(libs.find('glasgow_parts', sub)).toEqual([
      { kind: 'symbol', nick: 'glasgow_parts', path: `${sub}/glasgow_parts.kicad_sym`, id: 'prj.sym.glasgow_parts' },
      { kind: 'footprint', nick: 'glasgow_parts', path: `${sub}/glasgow_parts.pretty`, id: 'prj.fp.glasgow_parts' },
    ]);
    // At the root the footprint row names a folder that is not there.
    expect(libs.find('glasgow_parts')).toEqual([]);
    expect(libs.find('glasgow_parts', '../up')).toEqual([]);
  });

  it('serves a registered symbol library from its file at every ask: names, a derived symbol with its chain, the fat list alone', async () => {
    const fs = folder();
    const libs = createProjectLibs({ root: ROOT, fs: () => fs });
    const sym = libs.find('glasgow_parts')[0];
    expect(libs.owns(sym.id)).toBe(false);
    libs.register(sym);
    expect(libs.owns(sym.id)).toBe(true);
    expect(libs.registered('symbol', 'glasgow_parts')).toEqual(sym);
    expect(libs.registered('footprint', 'glasgow_parts')).toBeNull();
    expect(libs.uri(sym)).toBe('/mnt/pcbjam/prj.sym.glasgow_parts');
    expect(await libs.listItems(sym.id)).toEqual([{ kind: 'symbol', name: 'BASE' }, { kind: 'symbol', name: 'ST25DV04K' }, { kind: 'symbol', name: 'R "quoted"' }]);
    const derived = await libs.getItemBody(sym.id, 'symbol', 'ST25DV04K');
    // The chain root first, then the symbol, under the file's header.
    expect(derived).toMatch(/^\(kicad_symbol_lib\n\t\(version 20241209\)\n\t\(generator "kicad_symbol_editor"\)\n\t\(symbol "BASE"[\s\S]*\(symbol "ST25DV04K" \(extends "BASE"\)/);
    expect(await libs.getItemBody(sym.id, 'footprint', 'ST25DV04K')).toBeNull();
    expect(await libs.getItemBody(sym.id, 'symbol', 'nothing')).toBeNull();
    const all = await libs.getAllItems(sym.id);
    expect(all.map((i) => i.name)).toEqual(['BASE', 'ST25DV04K', 'R "quoted"']);
    // The fat list gives each symbol alone (the engine links its parent).
    expect(new TextDecoder().decode(all[1].body)).not.toContain('(symbol "BASE"');
    // A symbol written later is found on the next ask.
    fs.files.set(`${ROOT}/glasgow_parts.kicad_sym`, SYMS.replace(/\)\n$/, '\t(symbol "NEW" (in_bom yes))\n)\n'));
    expect((await libs.listItems(sym.id)).map((i) => i.name)).toContain('NEW');
  });

  it('serves a registered footprint library from its folder\'s .kicad_mod files, by stem', async () => {
    const fs = folder();
    const libs = createProjectLibs({ root: ROOT, fs: () => fs });
    const fp = libs.find('glasgow_parts')[1];
    libs.register(fp);
    expect(await libs.listItems(fp.id)).toEqual([{ kind: 'footprint', name: 'UFDFPN8' }]);
    expect(await libs.getItemBody(fp.id, 'footprint', 'UFDFPN8')).toBe(FP);
    expect(await libs.getItemBody(fp.id, 'footprint', '../sym-lib-table')).toBeNull();
    expect((await libs.getAllItems(fp.id)).map((i) => [i.name, new TextDecoder().decode(i.body)])).toEqual([['UFDFPN8', FP]]);
    fs.files.set(`${ROOT}/glasgow_parts.pretty/A_FIRST.kicad_mod`, '(footprint "A_FIRST")');
    expect((await libs.listItems(fp.id)).map((i) => i.name)).toEqual(['A_FIRST', 'UFDFPN8']);
    expect(libs.libInfos('footprint')).toEqual([{ id: 'prj.fp.glasgow_parts', name: 'glasgow_parts', description: 'This design\'s own library', type: 'project' }]);
    expect(libs.libInfos('symbol')).toEqual([]);
    expect(projectId('footprint', 'x')).toBe('prj.fp.x');
  });
});

describe('the source boot is given', () => {
  function base(): LibsSource & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      listLibs: async (kind?: string) => [{ id: 'sym.Device', name: 'Device', kind }].map(({ id, name }) => ({ id, name })),
      listItems: async (id: string) => { calls.push(`listItems ${id}`); return [{ kind: 'symbol', name: 'R' }]; },
      getItemBody: async (id: string, _k: string, name: string) => { calls.push(`get ${id} ${name}`); return `(body ${name})`; },
      getFpIndex: async () => '{"index":1}',
      presync: vi.fn(async () => undefined),
    };
  }

  it('answers a project library\'s ids from the folder and every other id from the base, its optional parts passed through', async () => {
    const fs = folder();
    const project = createProjectLibs({ root: ROOT, fs: () => fs });
    const b = base();
    const src = withProjectLibs(b, project);
    expect(await src.listLibs('footprint')).toEqual([{ id: 'sym.Device', name: 'Device' }]);
    for (const l of project.find('glasgow_parts')) project.register(l);
    expect((await src.listLibs('footprint')).map((l) => l.id)).toEqual(['prj.fp.glasgow_parts', 'sym.Device']);
    expect(await src.getItemBody('prj.fp.glasgow_parts', 'footprint', 'UFDFPN8')).toBe(FP);
    expect(await src.getItemBody('sym.Device', 'symbol', 'R')).toBe('(body R)');
    expect((await src.listItems('prj.fp.glasgow_parts')).map((i) => i.name)).toEqual(['UFDFPN8']);
    // The base has no bulk read: its items one by one.
    expect((await src.getAllItems!('sym.Device')).map((i) => [i.name, new TextDecoder().decode(i.body)])).toEqual([['R', '(body R)']]);
    expect(await src.getFpIndex!()).toBe('{"index":1}');
    await src.presync!({ kind: 'symbol' });
    expect(b.presync).toHaveBeenCalledWith({ kind: 'symbol' });
    expect(src.createLib).toBeUndefined();
    expect(b.calls).toEqual(['get sym.Device R', 'listItems sym.Device', 'get sym.Device R']);
  });
});

describe('path variables and design block rows (i-librows)', () => {
  const row = (uri: string, type = 'KiCad') => ({ name: 'n', type, uri });

  it('reads a request\'s variables closed: names in KiCad\'s form and none of KiCad\'s own, folders of the project in the normal form', () => {
    expect(readPathVars({ MYLIB: 'mylib', A_2: 'a/b' })).toEqual({ MYLIB: 'mylib', A_2: 'a/b' });
    for (const v of [null, [], {}, 'x', { mylib: 'a' }, { '_A': 'a' }, { A: '' }, { A: '/a' }, { A: 'a/../b' }, { A: 'a/' }, { A: 1 }, { ['A'.repeat(65)]: 'a' }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`V${i}`, 'a']))]) {
      expect(readPathVars(v)).toBeNull();
    }
    for (const name of ['KIPRJMOD', 'KICAD10_SYMBOL_DIR', 'KICAD6_FOOTPRINT_DIR', 'KICAD9_3DMODEL_DIR', 'KICAD8_TEMPLATE_DIR', 'KICAD10_3RD_PARTY', 'KICAD10_DESIGN_BLOCK_DIR', 'KICAD_USER_TEMPLATE_DIR', 'KICAD_PTEMPLATES']) {
      expect(isBuiltinPathVar(name)).toBe(true);
      expect(readPathVars({ [name]: 'a' })).toBeNull();
    }
    expect(isBuiltinPathVar('KICAD_SYMBOL_DIR')).toBe(false);
    expect(isBuiltinPathVar('MYLIB')).toBe(false);
  });

  it('resolves a ${KIPRJMOD} row from the project file\'s folder and a variable\'s row from the folder set, nothing else', () => {
    const vars = { MYLIB: 'libs/mine' };
    expect(rowPath(row('${KIPRJMOD}/a.kicad_sym'), 'symbol', '', vars)).toBe('a.kicad_sym');
    expect(rowPath(row('${KIPRJMOD}/a.kicad_sym'), 'symbol', 'Hw', vars)).toBe('Hw/a.kicad_sym');
    expect(rowPath(row('${MYLIB}/x.pretty'), 'footprint', 'Hw', vars)).toBe('libs/mine/x.pretty');
    expect(rowPath(row('${KIPRJMOD}/b.kicad_blocks'), 'block', '', vars)).toBe('b.kicad_blocks');
    for (const [uri, kind] of [
      ['${OTHER}/x.kicad_sym', 'symbol'],
      ['$(MYLIB)/x.kicad_sym', 'symbol'],
      ['${MYLIB}/../x.kicad_sym', 'symbol'],
      ['${MYLIB}/x.kicad_sym', 'footprint'],
      ['${MYLIB}/.kicad_blocks', 'block'],
      ['${KICAD10_SYMBOL_DIR}/Device.kicad_sym', 'symbol'],
      ['/abs/x.kicad_sym', 'symbol'],
    ] as const) expect(rowPath(row(uri), kind, '', vars)).toBeNull();
    expect(rowPath(row('${MYLIB}/x.kicad_sym', 'Legacy'), 'symbol', '', vars)).toBeNull();
    // projectPath stays the ${KIPRJMOD} rows alone.
    expect(projectPath(row('${MYLIB}/x.kicad_sym'), 'symbol')).toBeNull();
  });

  it('finds a library under a variable once it is set, and puts the variables back', () => {
    const fs = fakeFs({
      [`${ROOT}/sym-lib-table`]: '(sym_lib_table (version 7) (lib (name "MyLib")(type "KiCad")(uri "${MYLIB}/x.kicad_sym")(options "")(descr "")))',
      [`${ROOT}/fp-lib-table`]: '(fp_lib_table (version 7) (lib (name "MyLib")(type "KiCad")(uri "${MYLIB}/x.pretty")(options "")(descr "")))',
      [`${ROOT}/mylib/x.kicad_sym`]: SYMS,
      [`${ROOT}/mylib/x.pretty/R.kicad_mod`]: FP,
    });
    const libs = createProjectLibs({ root: ROOT, fs: () => fs });
    expect(libs.find('MyLib')).toEqual([]);
    const before = libs.setVars({ MYLIB: 'mylib' });
    expect(before).toEqual({});
    expect(libs.find('MyLib')).toEqual([
      { kind: 'symbol', nick: 'MyLib', path: 'mylib/x.kicad_sym', id: 'prj.sym.MyLib' },
      { kind: 'footprint', nick: 'MyLib', path: 'mylib/x.pretty', id: 'prj.fp.MyLib' },
    ]);
    // Merged over the earlier ones; restoreVars puts back what setVars answered.
    expect(libs.setVars({ OTHER: 'o' })).toEqual({ MYLIB: 'mylib' });
    expect(libs.vars()).toEqual({ MYLIB: 'mylib', OTHER: 'o' });
    libs.restoreVars(before);
    expect(libs.vars()).toEqual({});
    expect(libs.find('MyLib')).toEqual([]);
  });

  it('finds a design block row whose folder is there, registers and forgets it, and forgets a symbol or footprint registration', () => {
    const fs = folder({
      [`${ROOT}/design-block-lib-table`]: '(design_block_lib_table (version 7) (lib (name "b_blocks")(type "KiCad")(uri "${KIPRJMOD}/b_blocks.kicad_blocks")(options "")(descr "")))',
      [`${ROOT}/b_blocks.kicad_blocks/LDO.kicad_block/LDO.kicad_sch`]: '(kicad_sch)',
    });
    const libs = createProjectLibs({ root: ROOT, fs: () => fs });
    expect(parseLibTable(fs.files.get(`${ROOT}/design-block-lib-table`)!, 'block')).toEqual([{ name: 'b_blocks', type: 'KiCad', uri: '${KIPRJMOD}/b_blocks.kicad_blocks' }]);
    expect(libs.findBlock('b_blocks')).toEqual({ nick: 'b_blocks', path: 'b_blocks.kicad_blocks' });
    expect(libs.findBlock('glasgow_parts')).toBeNull();
    // find never names a block row: those are KiCad's reader's, never served by the island.
    expect(libs.find('b_blocks')).toEqual([]);
    libs.registerBlock({ nick: 'b_blocks', path: 'b_blocks.kicad_blocks' });
    expect(libs.registeredBlock('b_blocks')).toEqual({ nick: 'b_blocks', path: 'b_blocks.kicad_blocks' });
    libs.unregister('block', 'b_blocks');
    expect(libs.registeredBlock('b_blocks')).toBeNull();
    const [sym] = libs.find('glasgow_parts');
    libs.register(sym);
    libs.unregister('symbol', 'glasgow_parts');
    expect(libs.registered('symbol', 'glasgow_parts')).toBeNull();
    expect(libs.owns(sym.id)).toBe(false);
    for (const p of [...fs.files.keys()].filter((k) => k.startsWith(`${ROOT}/b_blocks.kicad_blocks/`))) fs.files.delete(p);
    expect(libs.findBlock('b_blocks')).toBeNull();
  });

  it('is reached by its project folder, the last made for a folder standing', () => {
    const a = createProjectLibs({ root: '/q/one', fs: () => null });
    expect(projectLibsAt('/q/one')).toBe(a);
    const b = createProjectLibs({ root: '/q/one', fs: () => null });
    expect(projectLibsAt('/q/one')).toBe(b);
    expect(projectLibsAt('/q/none')).toBeNull();
    expect(b.root).toBe('/q/one');
  });
});
