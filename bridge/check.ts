// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// sheet.check (PROTOCOL.md): KiCad's electrical rules check with no KiCad
// dialog, through our engine's kicadCheckSheet (pcbjam cc/main e8b2abe; engine
// run 10 serves it). The export queues the ERC dialog's preparation and the ERC
// job's body on the editor's apply coroutine; the run writes KiCad's own JSON
// report (erc.json, in mm) and then .cc-erc.json LAST, so the answer waits for
// the apply queue to empty and for that file, then reads the report.

import { UUID_RE, TEXT_MAX } from './symbol';
import { readLines, type RunLine } from './annotate';

/** The engine exports the op needs: the check, the apply queue probe. */
export const CHECK_EXPORTS = ['kicadCheckSheet', 'kicadCollabBusy'] as const;
/** Each run writes into a fresh folder under this one, outside the project folder. */
export const CHECK_ROOT = '/tmp/cc-erc';
/** The run's own record, written last. */
export const CHECK_DONE = '.cc-erc.json';
/** KiCad's report, beside the record. */
export const CHECK_REPORT = 'erc.json';
/** At most this many findings listed in one answer; past it the counts still total and `truncated` is set. */
export const MAX_VIOLATIONS = 4096;
/** At most this many items listed for one finding (KiCad names one or two). */
export const MAX_ITEMS = 64;
/** At most this many sheets in one answer. */
export const MAX_SHEETS = 4096;

export interface CheckDone { code: number; lines: RunLine[] }
export interface CheckItem { uuid: string; description: string }
export interface CheckViolation { type: string; severity: 'error' | 'warning'; items: CheckItem[] }
export interface CheckSheet { path: string; name: string; violations: CheckViolation[] }
export interface CheckResult { sheets: CheckSheet[]; errors: number; warnings: number; truncated?: true }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** KiCad's rule keys (erc_item.cpp): lower case words joined by "_" (and "generic-warning", "generic-error"). */
const RULE_KEY_RE = /^[a-z0-9_-]{1,64}$/;
/** A text cut to the protocol's bound, by code points. */
const cut = (s: string, max = TEXT_MAX): string => (s.length <= max ? s : [...s].slice(0, max).join(''));

/** .cc-erc.json's bytes read closed: null when absent or of any other shape. */
export function readCheckDone(bytes: Uint8Array | null): CheckDone | null {
  if (bytes == null) return null;
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  if (!isObj(v) || !Number.isSafeInteger(v.code)) return null;
  const lines = readLines(v.lines);
  return lines == null ? null : { code: v.code as number, lines };
}

/**
 * KiCad's `uuid_path` (the root sheet's uuid, then one uuid per level, slashes
 * between, none at the end) in project.open's sheet path form ("/" for the
 * root, then one uuid and a slash per level); null for any other spelling.
 */
export function sheetPathOf(uuidPath: string): string | null {
  const parts = uuidPath.split('/');
  if (parts[0] !== '') return null;
  const segs = parts.slice(1);
  if (segs.length > 0 && segs[segs.length - 1] === '') segs.pop();
  if (segs.length === 0 || segs.length > 65 || !segs.every((s) => UUID_RE.test(s))) return null;
  return `/${segs.slice(1).map((s) => `${s}/`).join('')}`;
}

/**
 * KiCad's ERC report (rc_json_schema.h ERC_REPORT, as ERC_REPORT::WriteJsonReport
 * writes it) as sheet.check's answer: every sheet in the report's order, its
 * path in project.open's form and its human path as its name, the findings not
 * excluded of severity error or warning, each with its rule key, severity and
 * items (uuid and KiCad's description; the positions left out: KiCad writes
 * them 100 times too small). The counts total every finding; past
 * MAX_VIOLATIONS listed the rest are counted only and `truncated` is set.
 * Null for a report of any other shape.
 */
export function readCheckReport(bytes: Uint8Array | null): CheckResult | null {
  if (bytes == null) return null;
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  if (!isObj(v) || !Array.isArray(v.sheets) || v.sheets.length > MAX_SHEETS) return null;
  const sheets: CheckSheet[] = [];
  let errors = 0, warnings = 0, listed = 0, truncated = false;
  for (const s of v.sheets as unknown[]) {
    if (!isObj(s) || typeof s.uuid_path !== 'string' || typeof s.path !== 'string' || !Array.isArray(s.violations)) return null;
    const path = sheetPathOf(s.uuid_path);
    if (path == null) return null;
    const violations: CheckViolation[] = [];
    for (const x of s.violations as unknown[]) {
      if (!isObj(x) || typeof x.type !== 'string' || !RULE_KEY_RE.test(x.type) || typeof x.severity !== 'string' || !Array.isArray(x.items)) return null;
      if (x.excluded !== undefined && typeof x.excluded !== 'boolean') return null;
      const items: CheckItem[] = [];
      for (const it of x.items as unknown[]) {
        if (!isObj(it) || typeof it.uuid !== 'string' || !UUID_RE.test(it.uuid) || typeof it.description !== 'string') return null;
        if (items.length < MAX_ITEMS) items.push({ uuid: it.uuid, description: cut(it.description) });
      }
      if (x.excluded === true || (x.severity !== 'error' && x.severity !== 'warning')) continue;
      if (x.severity === 'error') errors += 1; else warnings += 1;
      if (listed >= MAX_VIOLATIONS) { truncated = true; continue; }
      listed += 1;
      violations.push({ type: x.type, severity: x.severity, items });
    }
    sheets.push({ path, name: cut(s.path), violations });
  }
  return truncated ? { sheets, errors, warnings, truncated: true } : { sheets, errors, warnings };
}
