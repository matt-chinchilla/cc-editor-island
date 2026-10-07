// SPDX-License-Identifier: GPL-3.0-or-later
// Clones PCBJam at the pinned root commit into upstream/ (shallow, by tag),
// refreshes loader/pristine/ with the untouched closure, and copies the
// notice sources. At a bump, `git diff` over loader/pristine shows what
// upstream changed so the same change can be carried into loader/src.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const pin = JSON.parse(readFileSync('PIN.json', 'utf8'));
if (!existsSync('upstream/.git')) {
  execSync(`git clone --depth 1 --branch ${pin.pcbjam.tag} https://github.com/PCBJam/pcbjam.git upstream`, { stdio: 'inherit' });
}
const head = execSync('git -C upstream rev-parse HEAD').toString().trim();
if (head !== pin.pcbjam.root) throw new Error(`upstream is at ${head}, PIN.json pins ${pin.pcbjam.root}`);

const STANDALONE = 'upstream/web/standalone/src';
const CLOSURE = [
  'wasm/boot.ts', 'wasm/constants.ts', 'wasm/open-flow.ts', 'wasm/save-flow.ts', 'wasm/mailbox.ts',
  'wasm/fatal-screen.ts', 'wasm/terminal-error.ts', 'wasm/load-trace.ts', 'wasm/touch-gestures.ts',
  'wasm/libs/uri.ts', 'wasm/libs/source.ts', 'wasm/libs/static-source.ts', 'wasm/global.d.ts',
  'preflight/capabilities.ts', 'recovery/oom-watch.ts', 'lib/async-map.ts',
];
for (const rel of CLOSURE) {
  const dst = join('loader', 'pristine', rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(join(STANDALONE, rel), dst);
}
// The day the closure was taken: the notices census asks every changed copy in
// loader/src for a notice dated on or after it (never the copies' commit date,
// which a history rewrite moves).
pin.pcbjam.pristineTaken = new Date().toISOString().slice(0, 10);
writeFileSync('PIN.json', `${JSON.stringify(pin, null, 2)}\n`);
mkdirSync('notices', { recursive: true });
copyFileSync('upstream/site/src/content/legal/licenses.md', 'notices/pcbjam-licenses.md');
copyFileSync('upstream/scripts/common/versions.sh', 'notices/versions.sh');   // at v0.2.3 it lives in scripts/common (the plan expected scripts/deps)
execSync(`gh api repos/PCBJam/kicad-source-mirror/contents/LICENSE.README?ref=${pin.pcbjam.kicad} --jq .content | base64 -d > notices/kicad-LICENSE.README`, { stdio: 'inherit' });
console.log(`pristine closure refreshed from ${head}`);
