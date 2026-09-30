// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The release's notices and the census that guards them.
//
//   node scripts/notices.mjs            census, then write dist/r/<islandId>/{licenses.html, LICENSE.txt, NOTICE}
//   node scripts/notices.mjs --check    census only
//   node scripts/notices.mjs <outDir>   census, then write into <outDir>
//
// The census exits 1 naming what is wrong:
//   (a) every NAME= in notices/versions.sh belongs to an entry of DEPS below;
//   (b) every file in loader/src that differs from loader/pristine carries a
//       `Modified by Circuit Center on YYYY-MM-DD:` line dated on or after the
//       pristine copy's date (its last commit date, or its mtime when git does
//       not hold it unchanged);
//   (c) every copied file keeps its pristine counterpart's leading comment
//       block verbatim (PCBJam's files carry no licence header at the pin, so
//       the leading comment is the only header there is to keep); a file in
//       loader/src with no pristine counterpart is ours and must say so with
//       its SPDX line;
// and it refuses a page whose own prose has a dash or download wording, or
// that points at any address off the page (licenses.html carries relative
// links only; every outside address is text).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const OWNER = 'Chirichella Inc.';
const BRAND = 'Circuit Center';
const YEAR = '2026';
const GH = 'https://github.com/matt-chinchilla';

/**
 * Every dependency the pinned recipe's versions.sh names. `prefixes` claim its
 * NAME= variables (EMSDK_TARBALL_SHA256 belongs to emscripten, OCC_URL to OCCT).
 * `recipe` says what the recipe at the pin does with it, read from
 * upstream/scripts/deps and upstream/wasm/cmake; `licence` is the grant we
 * take it under.
 */
export const DEPS = [
  { key: 'kicad', name: 'KiCad', prefixes: ['KICAD'], recipe: 'the application itself, built from the kicad-source-mirror commit below', licence: 'GPL-3.0-or-later, with the third party parts KiCad\'s LICENSE.README lists (reproduced below)' },
  { key: 'emscripten', name: 'Emscripten', prefixes: ['EMSCRIPTEN', 'EMSDK'], recipe: 'the compiler toolchain; its runtime is linked into the WebAssembly and its JavaScript glue', licence: 'MIT (Emscripten is offered under the MIT License or the University of Illinois/NCSA Open Source License; we take it under MIT)' },
  { key: 'wxwidgets', name: 'wxWidgets', prefixes: ['WXWIDGETS'], recipe: 'built from PCBJam\'s wxWidgets fork at the commit below', licence: 'wxWindows Library Licence 3.1 for the toolkit; the WebAssembly port files, derived from ahilss/wxWidgets-wasm, under the GNU LGPL version 2 without the wxWindows exception' },
  { key: 'boost', name: 'Boost', prefixes: ['BOOST'], recipe: 'built from source', licence: 'BSL-1.0 (Boost Software License 1.0)' },
  { key: 'cairo', name: 'cairo', prefixes: ['CAIRO'], recipe: 'built from source', licence: 'LGPL-2.1 or MPL-1.1, at the recipient\'s choice' },
  { key: 'pixman', name: 'pixman', prefixes: ['PIXMAN'], recipe: 'built from source', licence: 'MIT' },
  { key: 'freetype', name: 'FreeType', prefixes: ['FREETYPE'], recipe: 'built from source', licence: 'FTL (the FreeType License; FreeType is also offered under GPL-2.0-or-later, we take it under the FTL)' },
  { key: 'harfbuzz', name: 'HarfBuzz', prefixes: ['HARFBUZZ'], recipe: 'built from source', licence: 'MIT (the "Old MIT" wording)' },
  { key: 'zstd', name: 'Zstandard', prefixes: ['ZSTD'], recipe: 'built from source', licence: 'BSD-3-Clause (zstd is also offered under GPL-2.0-only; we take it under BSD)' },
  { key: 'protobuf', name: 'Protocol Buffers', prefixes: ['PROTOBUF'], recipe: 'built from source', licence: 'BSD-3-Clause' },
  { key: 'glm', name: 'GLM', prefixes: ['GLM'], recipe: 'header only library', licence: 'MIT (GLM is also offered under the Happy Bunny License; we take it under MIT)' },
  { key: 'occt', name: 'Open CASCADE Technology (OCCT)', prefixes: ['OCC'], recipe: 'built from source', licence: 'LGPL-2.1 with the Open CASCADE exception' },
  { key: 'ngspice', name: 'ngspice', prefixes: ['NGSPICE'], recipe: 'built from source', licence: 'BSD (the modified BSD licence ngspice ships under)' },
  { key: 'rapidjson', name: 'RapidJSON', prefixes: ['RAPIDJSON'], recipe: 'header only, required by the OCCT glTF writer', licence: 'MIT', added: true },
  { key: 'curl', name: 'curl', prefixes: ['CURL'], recipe: 'headers only; curl calls are stubbed in the WebAssembly build', licence: 'curl (an MIT style licence)', added: true },
  { key: 'libgit2', name: 'libgit2', prefixes: ['LIBGIT2'], recipe: 'headers only; git functions do not run in the browser', licence: 'GPL-2.0 with the libgit2 linking exception', added: true },
  { key: 'python', name: 'Python', prefixes: ['PYTHON'], recipe: 'a build time interpreter only; Python scripting is disabled in the WebAssembly build and nothing of Python is linked', licence: 'PSF-2.0 (Python Software Foundation License)', added: true },
  { key: 'swig', name: 'SWIG', prefixes: ['SWIG'], recipe: 'named as a minimum version for native builds; the WebAssembly recipe does not run it', licence: 'GPL-3.0-or-later for SWIG itself; nothing of SWIG is linked', added: true },
];

// ---------------------------------------------------------------- inputs

const fail = (msg) => {
  console.error(`notices: ${msg}`);
  process.exit(1);
};
const read = (p) => readFileSync(p, 'utf8');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out.sort();
}

/** versions.sh assignments, in file order, the last value of a repeated name kept. */
export function parseVersions(text) {
  const vars = new Map();
  for (const m of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|(\S*))/gm)) {
    vars.set(m[1], m[3] ?? m[4] ?? m[5] ?? '');
  }
  return vars;
}

/** The DEPS entry owning a variable: the longest prefix that is the name or a `<prefix>_` start of it. */
export function ownerOf(name, deps = DEPS) {
  let best = null;
  let bestLen = -1;
  for (const d of deps) {
    for (const p of d.prefixes) {
      if ((name === p || name.startsWith(`${p}_`)) && p.length > bestLen) {
        best = d;
        bestLen = p.length;
      }
    }
  }
  return best;
}

const NOTICE_RE = /Modified by Circuit Center on (\d{4}-\d{2}-\d{2}):\s*(.*)$/;

/** The dated notices of a file: each notice line plus the `//` lines that continue it. */
export function readNotices(text) {
  const lines = text.split('\n');
  const notices = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(NOTICE_RE);
    if (!m) continue;
    const words = [m[2].trim()];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!/^\s*\/\//.test(l) || NOTICE_RE.test(l)) break;
      words.push(l.replace(/^\s*\/\/\s?/, '').trim());
    }
    notices.push({ date: m[1], text: words.join(' ').replace(/\s+/g, ' ').trim() });
  }
  return notices;
}

/** The leading comment block of a source file (blank lines before it skipped), or [] when it starts with code. */
export function leadingComment(text) {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const first = lines[i]?.trim() ?? '';
  const block = [];
  if (first.startsWith('/*')) {
    for (; i < lines.length; i++) {
      block.push(lines[i]);
      if (lines[i].includes('*/')) break;
    }
  } else if (first.startsWith('//')) {
    for (; i < lines.length && lines[i].trim().startsWith('//'); i++) block.push(lines[i]);
  }
  return block;
}

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The date a pristine copy was taken: its last commit date when git holds it unchanged, else its mtime. */
function pristineDate(path) {
  try {
    const dirty = execFileSync('git', ['status', '--porcelain', '--', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const day = execFileSync('git', ['log', '-1', '--format=%cs', '--', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!dirty && /^\d{4}-\d{2}-\d{2}$/.test(day)) return { day, from: 'commit' };
  } catch {
    // not a git checkout: fall through to the file's own date
  }
  return { day: isoDay(statSync(path).mtime), from: 'mtime' };
}

// ---------------------------------------------------------------- the census

export function census() {
  const versions = parseVersions(read('notices/versions.sh'));
  if (versions.size === 0) fail('notices/versions.sh names no dependency');
  for (const name of versions.keys()) {
    if (!ownerOf(name)) fail(`notices/versions.sh names ${name}, which has no entry in the dependency table (DEPS in scripts/notices.mjs)`);
  }

  const modified = [];
  const pristineRoot = join('loader', 'pristine');
  const srcRoot = join('loader', 'src');
  const pristine = new Set(walk(pristineRoot).map((p) => relative(pristineRoot, p)));
  let headers = 0;
  for (const rel of walk(srcRoot).map((p) => relative(srcRoot, p))) {
    const src = read(join(srcRoot, rel));
    if (!pristine.has(rel)) {
      if (!src.includes('SPDX-License-Identifier: GPL-3.0-or-later')) fail(`loader/src/${rel} has no counterpart in loader/pristine and no SPDX line of ours`);
      continue;
    }
    const orig = read(join(pristineRoot, rel));
    const header = leadingComment(orig);
    if (header.length > 0) {
      headers++;
      if (!src.includes(header.join('\n'))) {
        const srcLines = new Set(src.split('\n'));
        const missing = header.find((l) => !srcLines.has(l)) ?? header[0];
        fail(`loader/src/${rel} lacks its original header verbatim (from pristine: ${missing.trim()})`);
      }
    }
    if (src === orig) continue;
    const notices = readNotices(src);
    if (notices.length === 0) fail(`loader/src/${rel} differs from loader/pristine/${rel} and carries no "Modified by Circuit Center on YYYY-MM-DD:" notice`);
    const since = pristineDate(join(pristineRoot, rel));
    const newest = notices.map((n) => n.date).sort().at(-1);
    if (newest < since.day) fail(`loader/src/${rel}: newest notice ${newest} is older than its pristine copy (${since.day}, ${since.from})`);
    modified.push({ path: `loader/src/${rel}`, notices, since });
  }
  return { versions, modified, pristineCount: pristine.size, headers };
}

// ---------------------------------------------------------------- the page

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function versionOf(dep, versions) {
  const own = [...versions.entries()].filter(([k]) => ownerOf(k) === dep);
  const get = (suffix) => own.find(([k]) => k.endsWith(suffix))?.[1];
  const parts = [];
  const v = get('_VERSION');
  const commit = get('_COMMIT');
  const min = get('_MIN');
  if (v) parts.push(v);
  if (commit) parts.push(`commit ${commit}`);
  if (min) parts.push(`minimum ${min}`);
  const sha = own.find(([k]) => k.endsWith('SHA256'))?.[1];
  return { text: parts.join(', ') || 'named without a version', sha, vars: own.map(([k]) => k) };
}

export function render({ versions, modified }, pin, texts) {
  const id = pin.islandId;
  const release = `${GH}/cc-editor-island/releases/tag/${id}`;
  const mirrors = [
    { repo: 'pcbjam', what: 'PCBJam, the build recipe and the web sources', commit: pin.pcbjam.root },
    { repo: 'kicad-source-mirror', what: 'KiCad as PCBJam builds it', commit: pin.pcbjam.kicad },
    { repo: 'wxWidgets', what: 'wxWidgets with the WebAssembly port', commit: pin.pcbjam.wxwidgets },
  ];
  const engineFiles = Object.entries(pin.engine.files);
  const deps = DEPS.map((d) => ({ ...d, v: versionOf(d, versions) })).filter((d) => d.v.vars.length > 0);
  const added = deps.filter((d) => d.added).map((d) => d.name);

  // Our own prose, section by section, as [heading, html] pairs. The dash and
  // wording checks run over these; the reproduced texts are kept apart.
  const own = [];
  own.push(['Circuit Center editor', `
<p>This is the Circuit Center editor, release <code>${esc(id)}</code>: PCBJam's build of KiCad for the browser at PCBJam tag <code>${esc(pin.pcbjam.tag)}</code>, with a loader, a message responder and a theme by ${esc(BRAND)}.</p>
<p>Copyright (c) ${YEAR} ${esc(OWNER)} for the files ${esc(BRAND)} wrote. KiCad, PCBJam, wxWidgets and the libraries listed below are copyright their own authors.</p>
<p>This program is free software. The editor as a whole is conveyed to you under the GNU General Public License, version 3, and you may redistribute it and modify it under those terms. The files ${esc(BRAND)} wrote may also be used under any later version of that licence.</p>
<p>There is no warranty for this program, to the extent permitted by applicable law. It is provided as is, without warranty of any kind, either expressed or implied, including the implied warranties of merchantability and fitness for a particular purpose. Sections 15 and 16 of the licence say this in full.</p>
<p>The licence is served beside this page: <a href="LICENSE.txt">LICENSE.txt</a>. A plain text copy of this page is in <a href="NOTICE">NOTICE</a>.</p>`]);

  own.push(['Where the source is', `
<p>The complete corresponding source of this release is available at no charge from the places below, and stays there for as long as this release is served (GNU GPL version 3, section 6(d)).</p>
<ul>
<li>The island, our loader, responder, theme and these notices: the release <code>${esc(id)}</code> of the repository <code>${esc(GH)}/cc-editor-island</code>, at <code>${esc(release)}</code>. Its git tag is <code>${esc(id)}</code>.</li>
${mirrors.map((m) => `<li>${esc(m.what)}: the tag <code>cc/${esc(id)}</code> in <code>${esc(GH)}/${esc(m.repo)}</code>, commit <code>${esc(m.commit)}</code>.</li>`).join('\n')}
<li>The source archives of the libraries the recipe builds from, each pinned by the sha256 listed in the dependency table below, are attached to the same release.</li>
</ul>
<p>The build instructions for this release are PCBJam's own recipe at commit <code>${esc(pin.pcbjam.root)}</code>, in the pcbjam mirror at the tag <code>cc/${esc(id)}</code>: <code>.github/workflows/wasm-build.yml</code>, <code>docker/</code> and <code>scripts/</code>, with the versions in <code>scripts/common/versions.sh</code>.</p>
<p>The engine files served here, each checked against the sha256 PCBJam published for tag <code>${esc(pin.engine.toolTag)}</code>:</p>
<table><thead><tr><th>File</th><th>sha256</th><th>Built from</th></tr></thead><tbody>
${engineFiles.map(([name, f]) => `<tr><td data-label="File"><code>${esc(name)}</code></td><td data-label="sha256"><code class="hash">${esc(f.sha256)}</code></td><td data-label="Built from"><code class="hash">${esc(f.source)}</code></td></tr>`).join('\n')}
</tbody></table>
<p>The icon archive <code>images.tar.gz</code> is served repacked: ${esc(pin.icons.replacedEntries)} of its ${esc(pin.icons.entries)} entries are toolbar glyphs ${esc(BRAND)} redrew, every other entry is PCBJam's byte for byte. The repacked archive's sha256 is <code>${esc(pin.icons.repackedSha256)}</code>. Its preferred form for modification is <code>theme/icons/src</code> with <code>theme/icons/rasterise.mjs</code> and <code>theme/icons/repack.mjs</code> in the island repository.</p>`]);

  own.push(['Files we changed', `
<p>The loader is PCBJam's code, copied at the pin. The unchanged copies are kept in <code>loader/pristine</code> of the island repository. These copied files differ from PCBJam's; each carries the notices below, quoted from the file:</p>
<ul>
${modified.map((f) => `<li><code>${esc(f.path)}</code><ul class="notes">${f.notices.map((n) => `<li class="note">Modified by ${esc(BRAND)} on ${esc(n.date)}: ${esc(n.text)}</li>`).join('')}</ul></li>`).join('\n')}
</ul>`]);

  own.push(['Libraries and their licences', `
<p>Every dependency named by <code>scripts/common/versions.sh</code> in the pinned recipe, with the licence it comes under. ${added.length ? `The recipe names ${esc(added.length > 1 ? `${added.slice(0, -1).join(', ')} and ${added.at(-1)}` : added.join(''))} beyond the list our design names; they are here with their own licences.` : ''}</p>
<table><thead><tr><th>Dependency</th><th>Version</th><th>In the recipe</th><th>Licence</th></tr></thead><tbody>
${deps.map((d) => `<tr><td data-label="Dependency">${esc(d.name)}</td><td data-label="Version">${esc(d.v.text)}${d.v.sha ? `<br><span class="small">sha256 <code class="hash">${esc(d.v.sha)}</code></span>` : ''}</td><td data-label="In the recipe">${esc(d.recipe)}</td><td data-label="Licence">${esc(d.licence)}</td></tr>`).join('\n')}
</tbody></table>
<p>The kicad-source-mirror commit the engine was built from is <code>${esc(pin.pcbjam.kicad)}</code>, the gitlink at PCBJam's commit; the commit versions.sh names for KiCad is the recipe's own record and may be older. The wxWidgets fork is at <code>${esc(pin.pcbjam.wxwidgets)}</code>.</p>`]);

  own.push(['Phosphor Icons', `
<p>The six toolbar glyphs ${esc(BRAND)} redrew for the icon archive follow the Phosphor Icons Light style. Phosphor Icons is released under the MIT License; its notice follows as its authors wrote it.</p>`]);

  const theirs = [
    ['Phosphor Icons licence', texts.phosphor, 'notices/phosphor-LICENSE'],
    ["PCBJam's notices, reproduced as theirs", texts.pcbjam, `site/src/content/legal/licenses.md at PCBJam commit ${pin.pcbjam.root}`],
    ["KiCad's LICENSE.README", texts.kicad, `LICENSE.README at kicad-source-mirror commit ${pin.pcbjam.kicad}`],
  ];
  const theirsIntro = {
    "PCBJam's notices, reproduced as theirs": `<p>PCBJam's licences page at the pinned commit, reproduced unchanged. Its offer of source, its links and its contact address are PCBJam's and describe PCBJam's service, not this release; for this release use the places under "Where the source is" above.</p>`,
    "KiCad's LICENSE.README": `<p>KiCad's own statement of its licences, reproduced unchanged.</p>`,
    'Phosphor Icons licence': '',
  };
  for (const [h] of theirs) own.push([`${h} (introduction)`, theirsIntro[h]]);

  const ownHtml = own.map(([, html]) => html).join('\n');
  checkOwnProse(ownHtml);

  const section = (h, html) => `<section>\n<h2>${esc(h)}</h2>${html}\n</section>`;
  const ownSections = own.filter(([h]) => !h.endsWith('(introduction)'));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Licences and source</title>
<style>
:root { color-scheme: light dark; --paper: #fbfbf8; --ink: #1a1f23; --muted: #5a636b; --rule: #d9dde2; --well: #f1f3f5; }
@media (prefers-color-scheme: dark) { :root { --paper: #15191c; --ink: #e3e7ea; --muted: #9aa3ab; --rule: #2c3338; --well: #1d2226; } }
html, body { margin: 0; background: var(--paper); color: var(--ink); }
body { font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px 16px 64px; }
main { max-width: 860px; margin: 0 auto; }
h1 { font-size: 1.6rem; letter-spacing: -0.022em; margin: 0 0 4px; }
h2 { font-size: 1.15rem; letter-spacing: -0.015em; margin: 36px 0 8px; padding-top: 16px; border-top: 1px solid var(--rule); }
.lede { color: var(--muted); margin: 0 0 8px; }
a { color: inherit; }
code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.hash { font-size: 0.8em; }
.small { color: var(--muted); font-size: 0.85em; }
table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid var(--rule); }
ul.notes { margin: 4px 0 8px; }
@media (max-width: 640px) {
  table, tbody, tr, td { display: block; }
  thead { display: none; }
  tr { padding: 8px 0; border-bottom: 1px solid var(--rule); }
  td { border: 0; padding: 2px 0; }
  td::before { content: attr(data-label); display: block; color: var(--muted); font-size: 0.8em; }
}
pre { background: var(--well); padding: 12px; white-space: pre-wrap; overflow-wrap: anywhere; font: 0.82em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
</style>
</head>
<body>
<main>
<h1>Licences and source</h1>
<p class="lede">Circuit Center editor, release <code>${esc(id)}</code></p>
${ownSections.map(([h, body]) => section(h, body)).join('\n')}
${theirs.map(([h, text, from]) => section(h, `${theirsIntro[h] ? `\n${theirsIntro[h]}` : ''}\n<p class="small">From <code>${esc(from)}</code>.</p>\n<pre>${esc(text)}</pre>`)).join('\n')}
</main>
</body>
</html>
`;
  checkPage(html);

  const para = (s) => s.replace(/<br>/g, ' ').replace(/<ul class="notes">/g, '\n').replace(/<li class="note">/g, '    ').replace(/<li>/g, '- ').replace(/<\/(p|li|tr|h2)>/g, '\n').replace(/<\/t[dh]>/g, ' | ').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).join('\n');
  const notice = [
    `Licences and source: Circuit Center editor, release ${id}`,
    ...ownSections.map(([h, body]) => `\n== ${h} ==\n${para(body)}`),
    ...theirs.map(([h, text, from]) => `\n== ${h} ==\n${theirsIntro[h] ? `${para(theirsIntro[h])}\n` : ''}From ${from}.\n\n${text.trimEnd()}`),
    '',
  ].join('\n');
  return { html, notice };
}

/** Our prose renders no en or em dash and speaks of no download (owner rulings). */
function checkOwnProse(html) {
  const dash = html.match(/.{0,40}[\u2013\u2014].{0,40}/);
  if (dash) fail(`our own licences prose carries a dash: ${dash[0]}`);
  const dl = html.match(/.{0,40}download.{0,40}/i);
  if (dl) fail(`our own licences prose speaks of a download: ${dl[0]}`);
}

/** The page loads nothing, runs nothing and links only beside itself. */
function checkPage(html) {
  if (/<script|<link|<img|<iframe|\ssrc=|url\(|@import/i.test(html)) fail('licenses.html would load or run something');
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(m[1])) fail(`licenses.html links off the page: ${m[1]}`);
  }
}

// ---------------------------------------------------------------- main

function main() {
  const args = process.argv.slice(2);
  const pin = JSON.parse(read('PIN.json'));
  const result = census();
  console.log(`notices: census passed: ${result.versions.size} versions.sh names, all in the table; ${result.pristineCount} copied files, the ${result.headers} with a leading comment keep it verbatim; ${result.modified.length} modified, each with a dated notice`);
  for (const f of result.modified) console.log(`  ${f.path}: ${f.notices.length} notice(s), newest ${f.notices.map((n) => n.date).sort().at(-1)}, pristine ${f.since.day} (${f.since.from})`);
  if (args.includes('--check')) return;
  const out = args.find((a) => !a.startsWith('--')) ?? join('dist', 'r', pin.islandId);
  const texts = {
    pcbjam: read('notices/pcbjam-licenses.md'),
    kicad: read('notices/kicad-LICENSE.README'),
    phosphor: read('notices/phosphor-LICENSE'),
  };
  const { html, notice } = render(result, pin, texts);
  if (!existsSync(out)) mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'licenses.html'), html);
  writeFileSync(join(out, 'NOTICE'), notice);
  copyFileSync('LICENSE', join(out, 'LICENSE.txt'));
  console.log(`notices: wrote ${join(out, 'licenses.html')}, ${join(out, 'NOTICE')}, ${join(out, 'LICENSE.txt')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
