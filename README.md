# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/bayuanwar8/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/bayuanwar8/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, marked-compatible Markdown renderer — my entry for make.fun's "Make Markdown rendering faster" bounty. The goal is simple: render the same HTML as `marked` on every practice case, in as little CPU time as possible.

## Round 4 — what changed

Round 3 (commit `3a309fae`) rewrote the parser around direct HTML emission: inline constructs are scanned once and written straight into the output buffer, with no AST and no inline token tree, and the stops regex plus the escape/decode-refs step were fused into fewer passes. That build scores 720/720 against the practice reference at ~1.9x the wall speed of `marked` (~1.6x on CPU).

Round 4 keeps that architecture and attacks the remaining hot spots found by profiling the round 3 build independently (`node --cpu-prof` over the full 720-case set, two runs):

- `tokenizeInline` (~9–10% self time) and `scanInline` (~6–7%) — the inline scan loop itself.
- `listTok` (~8%) — list tokenization, the single most expensive block construct.
- `hideSpans` (~6%) and `maskSource` (~4–5%) — the masking passes that hide code spans / links before emphasis scanning.
- `tryEmphasis` (~5%) and `plainEnd` (~3–4%) — emphasis closers and plain-text runs.
- The trigger regexes (`TRIGGER_RE`, the stops regex, the `escapeHtml` character class) at ~2% each, plus ~2% GC.

The work is to shave those paths without changing a single output byte: every change is checked against the full 720-case differential test, a 10k+ input fuzzer, and a 5-run benchmark against both the round 3 build and the `marked` oracle.

## How it works

- `parse.js` — the whole renderer. One function, `parse(markdown)`, drives three stages: `tokenizeBlocks` splits the document into blocks (headings, lists, fences, tables, blockquotes, paragraphs), `tokenizeInline`/`scanInline` resolve inline markup inside each block, and the HTML is emitted directly into a string buffer as the scan goes — nothing is built into a tree first.
- `main.ts` — the thin driver the grader runs. It reads `cases.json`, calls `parse()` once per case in input order, and writes the HTML strings as a JSON array.
- No dependencies. No build step: `main.ts` runs directly under Node ≥ 22.6 via type stripping.

## How to run

```sh
node main.ts
```

It reads the cases from `/input/cases.json` and writes the rendered HTML to `/output/html.json`. For a local run, point the two directories at the kit instead:

```sh
MAKEFUN_INPUT_DIR=../markdown-render-speed-02-kit/markdown-render-speed-02-kit/practice/input \
MAKEFUN_OUTPUT_DIR=/tmp/out \
node main.ts
```

## How to verify

From the test harness next to this repo (720 practice cases vs the kit reference, 5-run benchmark vs the `marked` oracle):

```sh
node ../markdown-render-speed-02-test/diff.mjs    # expect 720/720
node ../markdown-render-speed-02-test/bench.mjs    # median wall + CPU vs marked
node ../scratch/fuzz.mjs 10000 <seed>             # expect 0 failures
```

Round 3 baseline for comparison: parse.js median wall 0.348 s, median CPU 0.430 s; marked median wall 0.675 s, median CPU 0.694 s (wall ×1.938, CPU ×1.612).

---

<sub>Entered on [make.fun](https://make.fun/?ref=psxszbrd&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
