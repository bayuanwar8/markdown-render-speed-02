// Entry driver: renders every case with the local parse() and writes
// the HTML strings (in case order) as a JSON array.
//
// The grader mounts the cases at /input/cases.json and expects the
// result at /output/html.json. Locally, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR override those paths so the same file runs
// outside the container too.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Entry = { id: string; markdown: string };

function readEntries(dir: string): Entry[] {
  const text = readFileSync(join(dir, 'cases.json'), 'utf8');
  return JSON.parse(text) as Entry[];
}

function main(): void {
  const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const entries = readEntries(inDir);
  const rendered: string[] = [];
  for (const entry of entries) {
    rendered.push(parse(entry.markdown));
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'html.json'), JSON.stringify(rendered));
}

main();
