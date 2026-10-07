// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Types for src/libs-builder/kit.mjs, so the strict typecheck can read the builder's tests.
export const ROOT: string;
export function tempDir(prefix: string): string;
export function removeDir(dir: string): void;
export function listDir(dir: string): string[];
export function readBytes(file: string): Uint8Array;
export function writeBytes(file: string, data: Uint8Array | string): void;
export function sha256(bytes: Uint8Array): string;
export function gunzip(bytes: Uint8Array): Uint8Array;
export function readStoredJson(dir: string, name: string): any;
export function readStoredText(dir: string, name: string): string;
export function pinJson(): any;
export function writeTree(root: string, files: Record<string, string>): void;
export function runCli(args: string[]): { status: number | null; stdout: string; stderr: string };
export function gitCommitAll(dir: string): string;
export function baseBlock(name: string, extra?: string): string;
export function derivedBlock(name: string, parent: string): string;
export function symbolFile(blocks: string[]): string;
export const R0603: string;
export const USB_C_LIKE: string;
export const ODD: string;
export const SYM_LICENCE: string;
export const FP_LICENCE: string;
export function fixtureSources(root: string, extra?: 'cycle' | 'orphan' | 'future' | null): { symbolsSrc: string; footprintsSrc: string };
