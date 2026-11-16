// Entry driver for the markdown-render-speed-02 bounty.
//
// Reads every practice case, renders each one with the local parse()
// (single-pass, marked-compatible), and writes the resulting HTML
// strings — in the same order as the input — as one JSON array.
//
// Contract with the grader:
//   * input : $MAKEFUN_INPUT_DIR/cases.json, or /input/cases.json
//   * output: $MAKEFUN_OUTPUT_DIR/html.json, or /output/html.json
//   * cases.json is [{ id, markdown }, ...]; html.json is [html, ...]
//
// Run locally with Node >= 22.6 (type stripping handles the .ts
// extension directly, no build step):
//   MAKEFUN_INPUT_DIR=.../practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface CaseEntry {
  id: string;
  markdown: string;
}

const DEFAULT_INPUT_DIR = '/input';
const DEFAULT_OUTPUT_DIR = '/output';
const CASES_FILE = 'cases.json';
const OUTPUT_FILE = 'html.json';

/** Directory holding cases.json: env override, else the grader mount. */
function inputDir(): string {
  return process.env.MAKEFUN_INPUT_DIR ?? DEFAULT_INPUT_DIR;
}

/** Directory receiving html.json: env override, else the grader mount. */
function outputDir(): string {
  return process.env.MAKEFUN_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR;
}

/**
 * Load and sanity-check the case list. Throws an Error with a plain
 * message naming the file and the problem, so a bad mount or a
 * malformed cases.json fails loudly instead of producing a silent
 * empty or partial output file.
 */
function loadCases(dir: string): CaseEntry[] {
  const file = join(dir, CASES_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${file}: ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`cannot parse ${file} as JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`${file} must contain a JSON array of cases, got ${typeof data}`);
  }
  for (let i = 0; i < data.length; i++) {
    const entry = data[i] as Partial<CaseEntry>;
    if (typeof entry !== 'object' || entry === null || typeof entry.markdown !== 'string') {
      throw new Error(`${file}: case at index ${i} has no string "markdown" field`);
    }
  }
  return data as CaseEntry[];
}

/** Render every case in input order; one HTML string per case. */
function renderCases(cases: CaseEntry[]): string[] {
  const html: string[] = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) {
    html[i] = parse(cases[i].markdown);
  }
  return html;
}

/** Create the output directory if needed, then write html.json. */
function saveHtml(dir: string, html: string[]): void {
  const file = join(dir, OUTPUT_FILE);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(html));
  } catch (err) {
    throw new Error(`cannot write ${file}: ${(err as Error).message}`);
  }
}

function main(): void {
  const inDir = inputDir();
  const outDir = outputDir();
  const cases = loadCases(inDir);
  const html = renderCases(cases);
  saveHtml(outDir, html);
}

try {
  main();
} catch (err) {
  console.error(`main.ts: ${(err as Error).message}`);
  process.exitCode = 1;
}
