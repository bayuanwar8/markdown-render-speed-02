// md.js — a Markdown to HTML renderer written from scratch, behaviourally
// matching marked 18.1.3 with its default options (gfm on, breaks off,
// pedantic off, async off). No dependencies, no I/O, nothing kept between
// calls: every parse(markdown) is computed purely from its input string.
//
// How it works: the document is first cut into blocks (headings, lists,
// quotes, fences, tables, ...) by a dispatch that looks at the first
// non-space character and only runs the patterns that could possibly match
// it. Inline spans inside each block are then resolved by a cursor-based
// scanner: one index walks the source once, sticky patterns match exactly
// at the cursor, and plain text runs are measured without ever copying the
// remaining string. HTML is emitted straight from the token lists, with
// `+=` appends (measured faster than array+join on this workload).
//
// The block and inline grammars below are my own transcription of the
// CommonMark 0.31.2 / GFM 0.29 rules as marked applies them, verified
// against marked's output on the practice set.

/* ------------------------------------------------------------------ */
/* character tables                                                    */
/* ------------------------------------------------------------------ */

// ASCII lookup tables, indexed by char code. Codes >= 128 read as
// undefined (falsy), so non-ASCII characters simply never match.
function fillRanges(table, ranges) {
  for (const [lo, hi] of ranges) {
    for (let c = lo; c <= hi; c++) table[c] = 1;
  }
}
function fillCodes(table, codes) {
  for (const c of codes) table[c] = 1;
}

const IS_ALNUM = new Uint8Array(128);
fillRanges(IS_ALNUM, [[48, 57], [65, 90], [97, 122]]);

// Characters that may appear in the local part of a bare email address.
const IS_MAIL_LOCAL = new Uint8Array(128);
fillRanges(IS_MAIL_LOCAL, [[48, 57], [65, 90], [97, 122]]);
fillCodes(IS_MAIL_LOCAL, [46, 33, 35, 36, 37, 38, 39, 42, 43, 47, 61, 63, 95, 96, 123, 124, 125, 126, 45]);

// Characters that can open an inline construct: backslash, <, !, [, `, *, ~, _.
const IS_TRIGGER = new Uint8Array(128);
fillCodes(IS_TRIGGER, [92, 60, 33, 91, 96, 42, 126, 95]);

// ASCII whitespace or punctuation, except * and _ (the left-delimiter
// test excludes those two). A non-ASCII previous character falls back to
// the Unicode regex.
const IS_LDELIM_PUNCT = new Uint8Array(128);
fillCodes(IS_LDELIM_PUNCT, [9, 10, 11, 12, 13, 32]);
fillRanges(IS_LDELIM_PUNCT, [[33, 41], [43, 47], [58, 64], [91, 94], [96, 96], [123, 126]]);

const RX_PUNCT = /[\p{P}\p{S}]/u;
const RX_LDELIM_PUNCT = /^((?![*_])[\s\p{P}\p{S}])/u;
const RX_ALNUM = /[\p{L}\p{N}]/u;
// Is `ch` (one code point, possibly '') punctuation or whitespace other
// than * or _? ASCII is a table lookup; anything else needs the regex.
function isDelimPunct(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code < 128) return IS_LDELIM_PUNCT[code] === 1;
  return RX_LDELIM_PUNCT.test(ch);
}

// Is `prev` (one code point, possibly '') alphanumeric? ASCII is a range
// check; anything else needs the Unicode test.
function isAlnumPrev(prev) {
  const code = prev.charCodeAt(0);
  if (code < 128) return IS_ALNUM[code] === 1;
  return RX_ALNUM.test(prev);
}

function isAlnumCode(code) {
  if (code >= 48 && code <= 57) return true;
  if (code >= 65 && code <= 90) return true;
  return code >= 97 && code <= 122;
}

/* ------------------------------------------------------------------ */
/* small string helpers                                                */
/* ------------------------------------------------------------------ */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape HTML special characters. With `encode` every & < > " ' is
// escaped; without it, an & that already starts a valid character
// reference or named entity is left alone (so `&copy;` survives, `&x`
// becomes `&amp;x`).
const RX_ESC = /[&<>"']/g;
const RX_ESC_SAFE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RX_ESC_TEST = /[&<>"']/;
const RX_ESC_SAFE_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
function escapeHtml(s, encode) {
  if (encode) {
    if (!RX_ESC_TEST.test(s)) return s;
    return s.replace(RX_ESC, (ch) => HTML_ESCAPES[ch]);
  }
  // The plain char-class test is far cheaper than the lookahead-bearing
  // safe test. Without '&' the two replaces agree (the '&' alternative
  // never fires), so only &-bearing strings need the full test.
  if (!RX_ESC_TEST.test(s)) return s;
  if (!s.includes('&')) return s.replace(RX_ESC, (ch) => HTML_ESCAPES[ch]);
  if (!RX_ESC_SAFE_TEST.test(s)) return s;
  return s.replace(RX_ESC_SAFE, (ch) => HTML_ESCAPES[ch] || '&amp;');
}

// Decode numeric character references in inline text. `&#38;` becomes
// `&amp;` (so it is not re-decoded), out-of-range / surrogate / zero code
// points become U+FFFD, and a bare & that is not part of a valid reference
// is written as `&amp;`. Named entities are NOT decoded here — they pass
// through untouched and the browser resolves them.
const RX_NUMREF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const RX_NUMREF_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeRefs(s) {
  if (!s.includes('&#')) return s;
  if (!RX_NUMREF.test(s)) return s;
  return s.replace(RX_NUMREF_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// Sanitise a link/image href the way marked does: encodeURI, then
// un-escape the %25 it produced (so a literal % in the source stays a
// literal %). Returns null when encodeURI throws (lone surrogates).
const RX_HREF_SAFE = /^[A-Za-z0-9;,\/?:@&=+$_.!~*'()#%-]*$/;
function sanitizeHref(href) {
  // encodeURI leaves exactly these characters (plus '%' whose %25 the
  // replace below undoes) untouched, so such hrefs need no work at all.
  if (RX_HREF_SAFE.test(href)) return href;
  try {
    const encoded = encodeURI(href);
    return encoded.includes('%25') ? encoded.replace(/%25/g, '%') : encoded;
  } catch {
    return null;
  }
}

// Split one table row on unescaped pipes, trimming cells and dropping the
// empty cells produced by leading / trailing pipes. Pads or truncates to
// `count` cells when given.
function splitRowCells(row, count) {
  // Without a backslash no pipe is escaped: splitting on '|' directly
  // gives the same cells as the replace-then-split below (which only
  // inserts a space before each unescaped pipe), and no cell needs its
  // escaped pipes restored.
  const hasBS = row.includes('\\');
  let cells;
  if (hasBS) {
    cells = row.replace(/\|/g, (ch, off, str) => {
      let escaped = false;
      for (let p = off - 1; p >= 0 && str[p] === '\\'; p--) escaped = !escaped;
      return escaped ? '|' : ' |';
    }).split(' |');
  } else {
    cells = row.split('|');
  }
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim();
    if (hasBS) cells[i] = cells[i].replace(/\\\|/g, '|');
  }
  return cells;
}

// Trim a run of `ch` from the end of `s` (or, with invert, a run of
// characters that are NOT `ch`).
function trimTail(s, ch, invert) {
  const n = s.length;
  if (n === 0) return '';
  let k = 0;
  while (k < n) {
    const c = s.charAt(n - k - 1);
    if (!invert && c === ch) k++;
    else if (invert && c !== ch) k++;
    else break;
  }
  return s.slice(0, n - k);
}

// Drop trailing blank lines, but keep the text unchanged when there are
// at most one of them (a single trailing blank line is part of the raw
// text).
function dropTrailingBlanks(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  if (lines.length - t <= 2) return s;
  return lines.slice(0, t + 1).join('\n');
}

// Expand tabs to spaces, tracking the visual column (tab stops every 4).
function expandTabs(s, col) {
  let out = '';
  let c = col || 0;
  for (const ch of s) {
    if (ch !== '\t') {
      out += ch;
      c++;
      continue;
    }
    const w = 4 - (c % 4);
    out += ' '.repeat(w);
    c += w;
  }
  return out;
}

// Normalise a link reference label: trim, collapse internal whitespace
// to single spaces, then case-fold (lower, upper, lower — the
// Unicode-aware fold marked uses, which also handles characters like İ
// and ß).
const RX_NON_ASCII = /[^\x00-\x7F]/;
function foldLabel(s) {
  const folded = s.trim().replace(/\s+/g, ' ');
  // ASCII labels fold with a single toLowerCase; the triple conversion
  // is only needed for non-ASCII case folding.
  if (!RX_NON_ASCII.test(folded)) return folded.toLowerCase();
  return folded.toLowerCase().toUpperCase().toLowerCase();
}

// Scan `s` tracking the balance of the pair `open`/`close`, skipping
// backslash-escaped characters. Returns -1 when balanced (or the pair
// never appears), -2 when an opener is left unmatched, or the index of
// the first unmatched closer.
function parenDepth(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Does the link label `label` (starting at offset `at` in the source
// `src`) contain a `<` that opens a raw HTML tag or autolink which is not
// closed inside the label? If so the link is not a link at all.
function labelOpensTag(src, label, at, ig) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const m = ig.code.exec(label.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(at + i);
    const m = ig.tag.exec(rest) || ig.autolink.exec(rest);
    if (m) {
      if (m[0].length > label.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}

// UTF-16 length of the first code point of `s` (1, or 2 for astral planes).
function firstCpLen(s) {
  const c = s.charCodeAt(0);
  if (c >= 0xD800 && c <= 0xDBFF && s.length > 1) return 2;
  return 1;
}

// The code point ending at index `i` of `s` (exclusive): one UTF-16 unit,
// or two when the last two units form a surrogate pair.
function cpBefore(s, i) {
  const lo = s.charCodeAt(i - 1);
  if (lo >= 0xDC00 && lo <= 0xDFFF && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xD800 && hi <= 0xDBFF) return s.slice(i - 2, i);
  }
  return s[i - 1];
}
const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const RX = {
  crlf: /\r\n|\r/g,
  blankLine: /^[ \t]*$/,
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  fenceIndent: /^(\s+)(?:```)/,
  leadingSpaces: /^\s+/,
  endingHash: /#$/,
  endsSpaceTab: /[ \t]$/,
  nonSpace: /[^ ]/,
  newlineGlobal: /\n/g,
  leadingSpaceTab: /^[ \t]+/,
  doubleBlank: /\n[ \t]*\n[ \t]*$/,
  quoteStart: /^ {0,3}>/,
  quoteSetext: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  quoteMarkerWs: /^( {0,3}>)([ \t]+)/gm,
  quoteStrip: /^ {0,3}>[ \t]?/gm,
  listNest: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listStripTask: /^\[[ xX]\][ \t]+/,
  taskBox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tablePipe: /[:|]/,
  tableEdge: /^\||\| *$/g,
  tableRowBlank: /\n[ \t]*$/,
  tableRight: /^ *-+: *$/,
  tableCenter: /^ *:-+: *$/,
  tableLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngle: /^</,
  endAngle: />$/,
  percent25: /%25/g,
  spaceOnlyLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  backslashPunct: /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  punct: /[\p{P}\p{S}]/u,
  punctNoTilde: /(?!~)[\p{P}\p{S}]/u,
  punctOrSpace: /[\s\p{P}\p{S}]/u,
  punctOrSpaceNoTilde: /(?!~)[\s\p{P}\p{S}]/u,
  notPunctOrSpace: /[^\s\p{P}\p{S}]/u,
  notPunctOrSpaceTilde: /(?:[^\s\p{P}\p{S}]|~)/u,
  punctBefore: /^((?![*_])[\s\p{P}\p{S}])/u,
  anyPunct: /\\([\p{P}\p{S}])/gu,
};

/* ------------------------------------------------------------------ */
/* block grammar                                                       */
/* ------------------------------------------------------------------ */

// Building the block regexes from templates keeps the paragraph / setext
// heading / table patterns consistent: each placeholder names the block
// construct that may interrupt the current one.

const BULLET_SRC = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const HR_SRC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEAD_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const QUOTE_SRC = ' {0,3}>';
const FENCE_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const HTML_OPEN_SRC = ' {0,3}(?:</?(?:' + BLOCK_TAGS + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const TABLE_SRC = ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n';
const TABLE_ROW_STOP = ' {0,3}(?:[*+-]|1[.)])[ \\t]';

function paraPattern(listSrc, tableSrc) {
  const template = '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
  // the table pattern is substituted before the HTML one: the HTML
  // pattern's tag list itself contains the word "table"
  const tablePart = tableSrc ? tableSrc.replace(/(^|[^\[])\^/g, '$1') : '';
  let built = template
    .replace('hr', HR_SRC)
    .replace('heading', HEAD_SRC)
    .replace('|lheading', '');
  built = tablePart ? built.replace('table', tablePart) : built.replace('|table', '');
  built = built
    .replace('blockquote', QUOTE_SRC)
    .replace('fences', FENCE_SRC)
    .replace('list', listSrc)
    .replace('html', HTML_OPEN_SRC);
  return new RegExp(built);
}

// Setext heading: text lines, then a line of = or -.
function setextPattern(tableSrc) {
  const template = '^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)' +
    '\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
  return new RegExp(
    template
      .replace(/bull/g, BULLET_SRC)
      .replace('blockCode', '(?: {4}| {0,3}\\t)')
      .replace(/fences/g, ' {0,3}(?:`{3,}|~{3,})')
      .replace(/blockquote/g, QUOTE_SRC)
      .replace(/heading/g, HEAD_SRC)
      .replace('hr', HR_SRC)
      .replace(/html/g, ' {0,3}<[^\\n>]+>\\n')
      .replace(/table/g, tableSrc)
  );
}

function tablePattern() {
  const template = '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)' +
    '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)';
  return new RegExp(
    template
      .replace('hr', HR_SRC)
      .replace('heading', HEAD_SRC)
      .replace('blockquote', QUOTE_SRC)
      .replace('code', '(?: {4}| {0,3}\\t)[^\\n]')
      .replace('fences', FENCE_SRC)
      .replace('list', TABLE_ROW_STOP)
      .replace('html', HTML_OPEN_SRC)
  );
}

// HTML block, type 1-7 (GFM): script/pre/style/textarea, comment,
// processing instruction, declaration, CDATA, block tag open/close, or a
// lone tag line.
const HTML_COMMENT_SRC = '<!--(?:-?>|[\\s\\S]*?(?:-->|$))';
const HTML_ATTR_SRC = ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?';
const BLOCK_HTML_SRC =
  '^ {0,3}(?:' +
  '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' +
  '|comment[^\\n]*(\\n+|$)' +
  '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' +
  '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' +
  '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' +
  '|</?(tag)(?:[ \\t]+|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' +
  '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' +
  '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' +
  ')';
const BLOCK_HTML = new RegExp(
  BLOCK_HTML_SRC.replace('comment', HTML_COMMENT_SRC).replace(/tag/g, BLOCK_TAGS).replace(/attribute/g, HTML_ATTR_SRC),
  'i'
);

const BG = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  indentedCode: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: new RegExp('^' + HR_SRC),
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  listStart: new RegExp('^(' + BULLET_SRC + ')([ \\t][^\\n]*?)?(?:\\n|$)'),
  html: BLOCK_HTML,
  defLabel: /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/,
  defTitle: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\)/,
  table: tablePattern(),
  setext: setextPattern(TABLE_SRC),
  paragraph: paraPattern(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]', tablePattern().source),
  text: /^[^\n]+/,
};
BG.def = new RegExp(
  ('^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)' +
    '(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)')
    .replace('label', BG.defLabel.source)
    .replace('title', BG.defTitle.source)
);
// the paragraph inside a blockquote may also be interrupted by any
// ordered list marker, so it gets its own variant
BG.quoteParagraph = paraPattern(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)', '');
BG.blockquote = new RegExp(
  '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+'
    // the embedded paragraph loses its ^ anchor, like any substituted part
    .replace('paragraph', BG.quoteParagraph.source.replace(/(^|[^\[])\^/g, '$1'))
);

// Indent-dependent break tests for list items. The indent used in the
// pattern is the content indent minus one, clamped to 0..3: a construct
// indented exactly to the item's content level belongs to the item, it
// does not interrupt it.
const indentCache = new Map();
function indentPattern(kind, n) {
  const indent = Math.max(0, Math.min(3, n - 1));
  const cacheKey = kind + ':' + indent;
  let pattern = indentCache.get(cacheKey);
  if (pattern) return pattern;
  if (kind === 'bullet') pattern = new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`);
  else if (kind === 'hr') pattern = new RegExp(`^ {0,${indent}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`);
  else if (kind === 'fences') pattern = new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`);
  else if (kind === 'heading') pattern = new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`);
  else if (kind === 'html') pattern = new RegExp(`^ {0,${indent}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
  else pattern = new RegExp(`^ {0,${indent}}>`);
  indentCache.set(cacheKey, pattern);
  return pattern;
}
const itemCache = new Map();
function itemPattern(markerSrc) {
  let pattern = itemCache.get(markerSrc);
  if (!pattern) {
    pattern = new RegExp(`^( {0,3}${markerSrc})((?:[ \\t][^\\n]*)?(?:\\n|$))`);
    itemCache.set(markerSrc, pattern);
  }
  return pattern;
}

/* ------------------------------------------------------------------ */
/* inline grammar                                                      */
/* ------------------------------------------------------------------ */

// A link label's inner text: nested bracket pairs, backslash escapes,
// code spans, or any character that is not a bracket, backslash or
// backtick. The lazy repetition stops at the first `]` that can close it.
const LABEL_INNER = '(?:\\[(?:brackets|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const BRACKET_PAIR = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
// A reference label: not empty, not just whitespace before `]`.
const REF_LABEL = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const REF_LABEL_SEARCH = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
// The longer label form used when scanning for reference links inside
// text that emphasis may not cross.
const LABEL_LONG = '(?:[^\\[\\]\\\\`]*(?:\\[(?:brackets|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';

function subst(src, placeholder, replacement) {
  // like marked's regex builder: a substituted pattern loses its ^ anchor
  // (so it can match mid-string) and the placeholder is replaced once
  // (or globally when a regex is passed)
  const replacementText = typeof replacement === 'string' ? replacement : replacement.source;
  return src.replace(placeholder, replacementText.replace(/(^|[^\[])\^/g, '$1'));
}

const LINK_LABEL = LABEL_INNER.replace(/brackets/g, BRACKET_PAIR);
const LINK_HREF = '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))';
const LINK_TITLE = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';

// Turn a ^-anchored pattern into a sticky one that matches exactly at
// lastIndex: the leading ^ (and any ^ at an alternation start, written
// here as "|^") is dropped, because the sticky flag already anchors the
// match. Character classes ([^...]) are untouched — only a ^ that begins
// the pattern or an alternative is removed.
function stickyOf(re, extraFlags) {
  const source = re.source.replace(/^\^|\|\^/g, '|').replace(/^\|/, '');
  const flagStr = re.flags.replace(/[gy]/g, '') + 'y' + (extraFlags || '');
  return new RegExp(source, flagStr);
}

const IG = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  // inline HTML: comment, closing tag, opening tag, processing
  // instruction, declaration, CDATA
  tag: new RegExp(
    (
      '^<!--(?:-?>|[\\s\\S]*?-->)|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' +
      '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>' +
      '|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>'
    ).replace(/attribute/g, '\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?')
  ),
  // <scheme:...> or <email>
  autolink: new RegExp(
    '^<(' +
      '[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*' +
      '|' +
      "[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])" +
      ')>'
  ),
  // extended autolinks: mailto:/xmpp: addresses, scheme:// URLs, www., email
  url: new RegExp(
    '^(?:(?:mailto:[a-zA-Z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])' +
    '|xmpp:[a-zA-Z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])(?:\\/[A-Za-z0-9@.]+)?)' +
    '|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*' +
    '|^[a-zA-Z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-]))'
  ),
  urlBackpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  // inline link: ![label](href "title") — the label/href/title parts
  // are substituted in below
  link: null,
  reflink: null,
  nolink: null,
  reflinkSearch: null,
  // constructs the emphasis mask must not look inside: links, code
  // spans, and raw HTML tags (each replaced by a same-length bracketed
  // filler)
  blockSkip: null,
  // punctuation outside code spans (escaped punctuation becomes '+'s)
  anyPunctOutsideCode: null,
  // emphasis left delimiter: a run of * or _ plus the character after
  // it. Group 1/2 = after a * run (punct / other), group 3/4 = after a
  // _ run. The (?!~) keeps ~ out of the punctuation class: ~ is the
  // strikethrough delimiter, not emphasis punctuation.
  emStrongL: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  delL: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  // "the character before the delimiter is punctuation or whitespace
  // (but not * or _)" — a single-character test
  punctBefore: /^((?![*_])[\s\p{P}\p{S}])/u,
  anyPunct: /\\([\p{P}\p{S}])/gu,
};

// link / reflink / nolink, built from the label pieces above
const LINK_TPL = '^!?\\[(label)\\]\\([ \\t\\n]*(href)(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(title))?[ \\t\\n]*\\)';
const REFLINK_TPL = '^!?\\[(label)\\]\\[(ref)\\]';
const NOLINK_TPL = '^!?\\[(ref)\\](?:\\[\\])?';
IG.link = new RegExp(
  subst(subst(subst(LINK_TPL, 'label', LINK_LABEL), 'href', LINK_HREF), 'title', LINK_TITLE)
);
IG.reflink = new RegExp(
  subst(subst(REFLINK_TPL, 'label', LINK_LABEL), 'ref', REF_LABEL)
);
IG.nolink = new RegExp(subst(NOLINK_TPL, 'ref', REF_LABEL));
// the global scanner for reference-style links, used by the emphasis
// mask and by linkInText; its ^ anchors are stripped so it matches
// mid-string
const REFLINK_LONG_TPL = subst(subst(REFLINK_TPL, 'label', LABEL_LONG.replace(/brackets/g, BRACKET_PAIR)), 'ref', REF_LABEL_SEARCH);
const NOLINK_LONG_TPL = subst(NOLINK_TPL, 'ref', REF_LABEL_SEARCH);
IG.reflinkSearch = new RegExp(
  subst(subst('reflink|nolink(?!\\()', 'reflink', REFLINK_LONG_TPL), 'nolink', NOLINK_LONG_TPL),
  'g'
);
const BLOCKSKIP_LINK_TPL = '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)';
IG.blockSkip = new RegExp(
  subst(
    subst(
      subst(
        subst('link|precode-code|html', 'link', BLOCKSKIP_LINK_TPL),
        'precode-', '(?<!`)()'),
      'code', '(?<b>`+)[^`]+\\k<b>(?!`)'),
    'html', '<(?! )[^<>]*?>'),
  'g'
);
IG.anyPunctOutsideCode = new RegExp(
  '(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\([\\p{P}\\p{S}])', 'gu'
);
// (plain text is scanned by plainEnd() below, not by a regex)

// Sticky (cursor-anchored) copies of the ^-anchored inline patterns, so
// the inline scanner can match them at the cursor without slicing the
// remaining string.
const IGY = {
  escape: stickyOf(IG.escape),
  code: stickyOf(IG.code),
  br: stickyOf(IG.br),
  tag: stickyOf(IG.tag),
  autolink: stickyOf(IG.autolink),
  url: stickyOf(IG.url),
  link: stickyOf(IG.link),
  reflink: stickyOf(IG.reflink),
  nolink: stickyOf(IG.nolink),
  emStrongL: stickyOf(IG.emStrongL),
  delL: stickyOf(IG.delL),
};

// Right-delimiter scanners for emphasis / strikethrough. Each
// alternative matches some skipped text plus a delimiter run; which
// group holds the run tells the scanner the run's flanking:
//   g1 run after punctuation, followed by space/end
//   g2 run after non-punct non-space, followed by punct/space/end
//   g3 run after punct/space, followed by non-punct non-space (open only)
//   g4 run after a space, followed by punctuation (open only)
//   g5 run after punctuation, followed by punctuation (open and close)
//   g6 run after non-punct non-space, followed by non-punct non-space (both)
// The templates use placeholder class names, substituted below: for
// emphasis the classes are tilde-aware (~ is not punctuation there), for
// strikethrough they are the plain Unicode classes.
// Build a closer-scanning regex from a template: the placeholder
// class names are substituted with the real classes for the delimiter
// at hand (tilde-aware for emphasis, plain Unicode for strikethrough).
function substituteCloserClasses(template, punct, punctSpace, notPunctSpace) {
  return template
    .replace(/notPunctSpace/g, notPunctSpace)
    .replace(/punctSpace/g, punctSpace)
    .replace(/punct/g, punct);
}
function mkCloserScan(template, punct, punctSpace, notPunctSpace) {
  return new RegExp(substituteCloserClasses(template, punct, punctSpace, notPunctSpace), 'gu');
}
const AST_CLOSER_TPL = [
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])',
  '|(?!\\*)punct(\\*+)(?=[\\s]|$)',
  '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)',
  '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)',
  '|[\\s](\\*+)(?!\\*)(?=punct)',
  '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)',
  '|notPunctSpace(\\*+)(?=notPunctSpace)',
].join('');
// The `_` closer scanner is the plain one: it has no "both" alternative
// for a run between two word characters (so `_foo_bar` stays literal),
// and its punctuation class is the plain Unicode one. (The tilde-aware
// variant with the extra alternative is only the pedantic one.)
const UND_CLOSER_TPL = [
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])',
  '|(?!_)punct(_+)(?=[\\s]|$)',
  '|notPunctSpace(_+)(?!_)(?=punctSpace|$)',
  '|(?!_)punctSpace(_+)(?=notPunctSpace)',
  '|[\\s](_+)(?!_)(?=punct)',
  '|(?!_)punct(_+)(?!_)(?=punct)',
].join('');
const DEL_CLOSER_TPL = [
  '^[^~]+(?=[^~])',
  '|(?!~)punct(~~?)(?=[\\s]|$)',
  '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)',
  '|(?!~)punctSpace(~~?)(?=notPunctSpace)',
  '|[\\s](~~?)(?!~)(?=punct)',
  '|(?!~)punct(~~?)(?!~)(?=punct)',
  '|notPunctSpace(~~?)(?=notPunctSpace)',
].join('');
IG.emStrongRAst = mkCloserScan(AST_CLOSER_TPL, '(?!~)[\\p{P}\\p{S}]', '(?!~)[\\s\\p{P}\\p{S}]', '(?:[^\\s\\p{P}\\p{S}]|~)');
IG.emStrongRUnd = mkCloserScan(UND_CLOSER_TPL, '[\\p{P}\\p{S}]', '[\\s\\p{P}\\p{S}]', '[^\\s\\p{P}\\p{S}]');
IG.delR = mkCloserScan(DEL_CLOSER_TPL, '[\\p{P}\\p{S}]', '[\\s\\p{P}\\p{S}]', '[^\\s\\p{P}\\p{S}]');

// Sticky one-shot versions of each closer template's FIRST alternative
// (the skip alternative: a `__...*...__`, `**..._...**` or leading
// non-`~` run that can never hold a closer). In the original design
// that alternative could only ever fire at the start of the scan —
// its `^` anchor fails everywhere else — so instead of slicing the
// source and re-running the whole scan on the copy, the closer scan
// below runs the full `g` regex on the uncut string with
// lastIndex = scanStart, and fires the skip alternative once, here,
// at exactly scanStart. Same matches, no per-attempt copy of the rest
// of the paragraph (the copy is what made long paragraphs quadratic:
// every emphasis attempt re-flattened the remaining text).
function mkCloserSkip(template, punct, punctSpace, notPunctSpace) {
  const firstAlt = template.split('|')[0].replace(/^\^/, '');
  return new RegExp(substituteCloserClasses(firstAlt, punct, punctSpace, notPunctSpace), 'yu');
}
IG.emStrongSkipAst = mkCloserSkip(AST_CLOSER_TPL, '(?!~)[\\p{P}\\p{S}]', '(?!~)[\\s\\p{P}\\p{S}]', '(?:[^\\s\\p{P}\\p{S}]|~)');
IG.emStrongSkipUnd = mkCloserSkip(UND_CLOSER_TPL, '[\\p{P}\\p{S}]', '[\\s\\p{P}\\p{S}]', '[^\\s\\p{P}\\p{S}]');
IG.delSkip = mkCloserSkip(DEL_CLOSER_TPL, '[\\p{P}\\p{S}]', '[\\s\\p{P}\\p{S}]', '[^\\s\\p{P}\\p{S}]');
IG.delSkip = mkCloserSkip(DEL_CLOSER_TPL, '[\\p{P}\\p{S}]', '[\\s\\p{P}\\p{S}]', '[^\\s\\p{P}\\p{S}]');

/* ------------------------------------------------------------------ */
/* emphasis masking                                                    */
/* ------------------------------------------------------------------ */

// Scan a (masked) inline source for the last delimiter run that could
// close emphasis / strikethrough: the run's first character must not be
// preceded by whitespace. The index recorded is the run's first
// character. This is only an upper bound for the closer search — the
// real flanking rules are checked by the delimiter scanners. Walking
// back from the last occurrence of each delimiter (native lastIndexOf)
// is far cheaper than scanning every character of a long paragraph.
// Shared empty emphasis-closer map (never mutated) for sources without
// an emphasis delimiter.
const NO_CLOSERS_EM = { '*': -1, _: -1 };

// Scan a (masked) inline source for the last delimiter run that could
// close emphasis / strikethrough: the run's first character must not be
// preceded by whitespace. The index recorded is the run's first
// character. This is only an upper bound for the closer search — the
// real flanking rules are checked by the delimiter scanners. Walking
// back from the last occurrence of each delimiter (native lastIndexOf)
// is far cheaper than scanning every character of a long paragraph.
// Shared empty emphasis-closer map (never mutated) for sources without
// an emphasis delimiter.
function findClosers(src) {
  const emMap = { '*': -1, _: -1 };
  let delPos = -1;
  for (let di = 0; di < 3; di++) {
    const d = di === 0 ? '*' : di === 1 ? '_' : '~';
    let tail = src.lastIndexOf(d);
    while (tail !== -1) {
      let runStart = tail;
      while (runStart > 0 && src[runStart - 1] === d) runStart--;
      const before = runStart === 0 ? 10 : src.charCodeAt(runStart - 1);
      const isWs = before === 32 || before === 9 || before === 10 || before === 13 || before === 12;
      if (!isWs) {
        if (d === '~') delPos = runStart;
        else emMap[d] = runStart;
        break;
      }
      // A run before this one must end at or before runStart - 2
      // (runStart - 1 holds the whitespace before this run); with
      // runStart < 2 there is no earlier run. (lastIndexOf with a
      // negative from-index searches from the END of the string, so it
      // must never be called with runStart - 2 < 0.)
      tail = runStart >= 2 ? src.lastIndexOf(d, runStart - 2) : -1;
    }
  }
  return { text: src, em: emMap, del: delPos };
}

// Replace backticks inside code spans with '+' (so the span-hiding pass
// can match those spans), without a regex: for each opening backtick
// run find the first later run of the same length that can close it —
// the same span the anyPunctOutsideCode regex would match, since a
// closer must start right after a non-backtick character and be a
// maximal run. Returns the input unchanged (no allocation) when no code
// span contains an interior backtick.
function hideInnerTicks(t) {
  const n = t.length;
  let cursor = 0;
  let chunks = null;
  for (;;) {
    const openAt = t.indexOf('`', cursor);
    if (openAt === -1) break;
    let afterOpen = openAt;
    while (afterOpen < n && t.charCodeAt(afterOpen) === 96) afterOpen++;
    const openLen = afterOpen - openAt;
    let closeAt = -1;
    let probe = afterOpen;
    while (probe < n) {
      const tick = t.indexOf('`', probe);
      if (tick === -1) break;
      let afterTick = tick;
      while (afterTick < n && t.charCodeAt(afterTick) === 96) afterTick++;
      if (afterTick - tick === openLen && tick > afterOpen) { closeAt = tick; break; }
      probe = afterTick;
    }
    if (closeAt === -1) {
      if (chunks !== null) chunks.push(t.slice(cursor, afterOpen));
      cursor = afterOpen;
      continue;
    }
    const inner = t.slice(afterOpen, closeAt);
    if (!inner.includes('`')) {
      if (chunks !== null) chunks.push(t.slice(cursor, closeAt + openLen));
      cursor = closeAt + openLen;
      continue;
    }
    if (chunks === null) chunks = [t.slice(0, afterOpen)];
    else chunks.push(t.slice(cursor, afterOpen));
    chunks.push(inner.replace(/`/g, '+'), t.slice(closeAt, closeAt + openLen));
    cursor = closeAt + openLen;
  }
  if (chunks === null) return t;
  chunks.push(t.slice(cursor));
  return chunks.join('');
}

// Inline link starting at `t[start]` ('['): the label runs to the first
// ']' (a '[' outside a code span ends it, a code span's closer is the
// first backtick run after its opener and must have the opener's
// length), then '(' and a destination with one level of paren nesting
// and backslash escapes, then ')'. Returns the index just past the ')',
// or -1 when the text is not an inline link. This mirrors the link
// alternative of the blockSkip regex.
function inlineLinkSpan(t, start) {
  const n = t.length;
  let i = start + 1;
  while (i < n) {
    const code = t.charCodeAt(i);
    if (code === 93) break; // ']' ends the label
    if (code === 91) return -1; // '[' cannot appear in the label
    if (code === 96) { // backtick run: skip the code span it opens
      let spanEnd = i;
      while (spanEnd < n && t.charCodeAt(spanEnd) === 96) spanEnd++;
      const spanLen = spanEnd - i;
      const closer = t.indexOf('`', spanEnd);
      if (closer === -1) return -1;
      let closerEnd = closer;
      while (closerEnd < n && t.charCodeAt(closerEnd) === 96) closerEnd++;
      if (closerEnd - closer !== spanLen) return -1;
      i = closerEnd;
      continue;
    }
    i++;
  }
  if (i >= n || t.charCodeAt(i + 1) !== 40) return -1; // no ']' or no '('
  let depth = 0;
  let j = i + 2;
  while (j < n) {
    const code = t.charCodeAt(j);
    if (code === 92) { j += 2; continue; } // backslash escape
    if (code === 40) { // '('
      if (depth === 1) return -1; // cannot nest deeper: the link fails
      depth = 1;
      j++;
      continue;
    }
    if (code === 41) { // ')'
      if (depth === 1) { depth = 0; j++; continue; }
      return j + 1;
    }
    j++;
  }
  return -1;
}

// Replace links, code spans and raw HTML tags with same-length
// bracketed fillers, without a regex — the same matches the blockSkip
// regex would find. One left-to-right pass: at each step the next '[',
// backtick or '<' decides what is tried (a match can only start at one
// of those), and a construct that does not match is left literal. A link
// is only attempted when `withLinks` is set (a link needs ']('
// somewhere). Returns the input unchanged (no allocation) when nothing
// matches.
function hideSpans(t, withLinks) {
  const n = t.length;
  let pos = 0;
  let chunks = null;
  let htmlExhausted = false;
  // Once a search from some position finds no '`', '<' or '[' at
  // all, no later search (from a further position) can find one
  // either — so each is searched at most until its first miss,
  // instead of re-scanning the rest of the string per construct.
  let noMoreTicks = false;
  let noMoreLt = false;
  let noMoreBr = false;
  for (;;) {
    let tickAt = -1;
    if (!noMoreTicks) {
      tickAt = t.indexOf('`', pos);
      if (tickAt === -1) noMoreTicks = true;
    }
    let ltAt = -1;
    if (!htmlExhausted && !noMoreLt) {
      ltAt = t.indexOf('<', pos);
      if (ltAt === -1) noMoreLt = true;
    }
    let brAt = -1;
    if (withLinks && !noMoreBr) {
      brAt = t.indexOf('[', pos);
      if (brAt === -1) noMoreBr = true;
    }
    let nextAt = -1;
    let kind = 0; // 1 = backtick, 2 = '<', 3 = '['
    if (tickAt !== -1) { nextAt = tickAt; kind = 1; }
    if (ltAt !== -1 && (nextAt === -1 || ltAt < nextAt)) { nextAt = ltAt; kind = 2; }
    if (brAt !== -1 && (nextAt === -1 || brAt < nextAt)) { nextAt = brAt; kind = 3; }
    if (nextAt === -1) break;
    if (kind === 3) {
      const linkEnd = inlineLinkSpan(t, nextAt);
      if (linkEnd === -1) {
        // Not a link: the '[' stays literal.
        if (chunks !== null) chunks.push(t.slice(pos, nextAt + 1));
        pos = nextAt + 1;
        continue;
      }
      if (chunks === null) chunks = [t.slice(0, nextAt)];
      else chunks.push(t.slice(pos, nextAt));
      chunks.push('[' + 'a'.repeat(linkEnd - nextAt - 2) + ']');
      pos = linkEnd;
    } else if (kind === 1) {
      let runEnd = nextAt;
      while (runEnd < n && t.charCodeAt(runEnd) === 96) runEnd++;
      const runLen = runEnd - nextAt;
      // The closer is the first later run of the opener's length: a
      // code span's content may hold backtick runs of other lengths, so
      // the first run is not necessarily the closer. A code span cannot
      // start mid-run, so a miss advances past the run.
      let closeAt = -1;
      let probe = runEnd;
      while (probe < n) {
        const tick = t.indexOf('`', probe);
        if (tick === -1) break;
        let tickEnd = tick;
        while (tickEnd < n && t.charCodeAt(tickEnd) === 96) tickEnd++;
        if (tickEnd - tick === runLen) { closeAt = tick; break; }
        probe = tickEnd;
      }
      if (closeAt === -1) {
        if (chunks !== null) chunks.push(t.slice(pos, runEnd));
        pos = runEnd;
        continue;
      }
      if (chunks === null) chunks = [t.slice(0, nextAt)];
      else chunks.push(t.slice(pos, nextAt));
      chunks.push('[' + 'a'.repeat(closeAt + runLen - nextAt - 2) + ']');
      pos = closeAt + runLen;
    } else {
      // HTML tag
      if (t.charCodeAt(nextAt + 1) === 32) {
        if (chunks !== null) chunks.push(t.slice(pos, nextAt + 1));
        pos = nextAt + 1;
        continue;
      }
      const gtAt = t.indexOf('>', nextAt + 1);
      if (gtAt === -1) { htmlExhausted = true; continue; }
      const lt2 = t.indexOf('<', nextAt + 1);
      if (lt2 !== -1 && lt2 < gtAt) {
        if (chunks !== null) chunks.push(t.slice(pos, nextAt + 1));
        pos = nextAt + 1;
        continue;
      }
      if (chunks === null) chunks = [t.slice(0, nextAt)];
      else chunks.push(t.slice(pos, nextAt));
      chunks.push('[' + 'a'.repeat(gtAt - nextAt - 1) + ']');
      pos = gtAt + 1;
    }
  }
  if (chunks === null) return t;
  chunks.push(t.slice(pos));
  return chunks.join('');
}

// Cheap necessary condition for a reference-style link anywhere in
// `src`: a full `[label][ref]` contains '][', and a shortcut `[label]`
// (or `[label][]`) has a ']' not followed by '('. When neither holds,
// the reference-link search regex cannot match, so it is skipped.
function mayHaveRef(src) {
  if (src.includes('][')) return true;
  let p = src.indexOf(']');
  while (p !== -1) {
    if (src.charCodeAt(p + 1) !== 40) return true;
    p = src.indexOf(']', p + 1);
  }
  return false;
}

// Build the masked copy of an inline source that the emphasis scanner
// works on: reference-link labels that resolve are hidden (their text
// can never be an emphasis closer), escaped punctuation becomes '+'s,
// and links / code spans / raw HTML are replaced by same-length
// bracketed fillers, so delimiters inside them are invisible to the
// scanner.
function maskSource(src, doc) {
  let t = src;
  if (doc.hasLinks && src.includes('[') && src.includes(']') && mayHaveRef(src)) {
    const rx = IG.reflinkSearch;
    const hideOne = (m) => {
      const o = m.lastIndexOf('[');
      if (!Object.hasOwn(doc.links, doc.foldLabel(m.slice(o + 1, -1)))) return m;
      if (o > 1 && m.charAt(0) !== '!') {
        const inner = m.slice(1, o - 1);
        if (hasLinkInside(inner, doc)) {
          return '[' + inner.replace(rx, hideOne) + '][' + 'a'.repeat(m.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m.length - 2) + ']';
    };
    t = t.replace(rx, hideOne);
  }
  // escaped punctuation only exists when there is a backslash; without
  // one only code spans with interior backticks need masking — and only
  // when an inline link is present, because the hand scanner below
  // matches such spans directly while the blockSkip regex cannot
  if (src.includes('\\')) {
    t = t.replace(IG.anyPunctOutsideCode, (m, ticks, punct) =>
      punct ? '+'.repeat(m.length)
        : ticks ? ticks + m.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks
        : m);
  } else if (src.includes('`') && t.includes('](')) {
    t = hideInnerTicks(t);
  }
  // links, code spans and raw HTML only exist when one of ](, `, <
  // appears. With no inline link the blockSkip regex's link alternative
  // cannot match, so the hand scanner above does the same job without a
  // regex.
  if (src.includes('](') || src.includes('`') || src.includes('<')) {
    t = hideSpans(t, t.includes(']('));
  }
  return t;
}

// Does `src` contain a link (inline or reference) anywhere inside it?
// Used by the mask to decide whether a reference label's inner text
// must be masked recursively.
function hasLinkInside(src, doc) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(IG.blockSkip)) {
    if (IG.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(IG.reflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(doc.links, doc.foldLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && hasLinkInside(s.slice(1, r - 1), doc))) return true;
  }
  return false;
}
const RX_PLAIN_INLINE = /["'&<>\\[\]`*_~]|www\.|:\/\/|@|mailto:|xmpp:|  \n/;

const RX_TRIGGER = /[\\<!\[`*~_]/g;
// Stops that can end a plain-text token before the next trigger
// character: a scheme:// URL, www., mailto:/xmpp:, an email address, or
// a hard-break run of two or more spaces before a newline. One native
// scan finds the next occurrence of any of them; each is then validated
// in place. (An email's '@' may sit after the next trigger while its
// local part starts before it — that case is handled separately below.)
// Autolink / hard-break stop candidates are collected once per inline
// source by a single regex pass (see buildStops). The full alternation
// has six branches whose first characters are all distinct ('/', 'w',
// 'm', 'x', '@', ' '), so at any position at most one branch can match
// — a source only needs the branches whose pattern occurs in it, and
// the match set is identical with the reduced alternation. The reduced
// regexes are compiled once per kind-mask and reused; the cache holds
// static regexes only, no case data, so parses stay stateless.
const STOPS_RX_CACHE = new Map();
// Stops that can end a plain-text token before the next trigger
// character: a scheme:// URL, www., mailto:/xmpp:, an email address, or
// a hard-break run of two or more spaces before a newline. One native
// scan finds the next occurrence of any of them; each is then validated
// in place. (An email's '@' may sit after the next trigger while its
// local part starts before it — that case is handled separately below.)
// Autolink / hard-break stop candidates are collected once per inline
// source by a single regex pass (see buildStops). The full alternation
// has six branches whose first characters are all distinct ('/', 'w',
// 'm', 'x', '@', ' '), so at any position at most one branch can match
// — a source only needs the branches whose pattern occurs in it, and
// the match set is identical with the reduced alternation. The reduced
// regexes are compiled once per kind-mask and reused; the cache holds
// static regexes only, no case data, so parses stay stateless.
function stopsRx(mask) {
  const cached = STOPS_RX_CACHE.get(mask);
  if (cached) return cached;
  const branches = [];
  if (mask & 1) branches.push(':\\/\\/');
  if (mask & 2) branches.push('www\\.');
  if (mask & 4) branches.push('mailto:');
  if (mask & 8) branches.push('xmpp:');
  if (mask & 16) branches.push('@');
  if (mask & 32) branches.push(' {2,}\\n');
  const rx = new RegExp(branches.join('|'), 'g');
  STOPS_RX_CACHE.set(mask, rx);
  return rx;
}

// Does http://, https:// or ftp:// start at `i` (case-insensitive)?
function schemeAt(src, i) {
  const first = src.charCodeAt(i) | 32;
  if (first === 104) { // h: http or https
    if ((src.charCodeAt(i + 1) | 32) !== 116) return false;
    if ((src.charCodeAt(i + 2) | 32) !== 116) return false;
    if ((src.charCodeAt(i + 3) | 32) !== 112) return false;
    let j = i + 4;
    if ((src.charCodeAt(j) | 32) === 115) j++;
    return src.charCodeAt(j) === 58 && src.charCodeAt(j + 1) === 47 && src.charCodeAt(j + 2) === 47;
  }
  if (first === 102) { // f: ftp
    if ((src.charCodeAt(i + 1) | 32) !== 116) return false;
    if ((src.charCodeAt(i + 2) | 32) !== 112) return false;
    return src.charCodeAt(i + 3) === 58 && src.charCodeAt(i + 4) === 47 && src.charCodeAt(i + 5) === 47;
  }
  return false;
}

// Does `www.` start at `i`, with a start-of-string / whitespace / * / _ /
// ~ / ( character before it? (lowercase only, like the reference regex)
function wwwAt(src, i) {
  if (src.charCodeAt(i) !== 119 || src.charCodeAt(i + 1) !== 119 ||
      src.charCodeAt(i + 2) !== 119 || src.charCodeAt(i + 3) !== 46) return false;
  if (i === 0) return true;
  const p = src.charCodeAt(i - 1);
  if (p === 32 || p === 9 || p === 10 || p === 11 || p === 12 || p === 13) return true;
  return p === 42 || p === 95 || p === 126 || p === 40;
}

// Does an email address (local part + '@') start at position `i`?
function emailStartsAt(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && IS_MAIL_LOCAL[src.charCodeAt(j)]) j++;
  return j > i && j < n && src.charCodeAt(j) === 64;
}

// Does a run of two or more spaces starting at `i` end in a newline?
function hardBreakAt(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && src.charCodeAt(j) === 32) j++;
  return j - i >= 2 && j < n && src.charCodeAt(j) === 10;
}

// Could `src` start an extended autolink at `pos`? The full URL regex
// is only attempted when this says yes: www., an http/https/ftp scheme,
// mailto:/xmpp:, or an '@' inside the characters a bare email address
// may start with. Anything else cannot match, so the attempt is
// skipped. (Checked with charCodeAt so no substring is allocated per
// token.) The email scan only runs when `scanAt` is set — without '@'
// anywhere in the source it could never find one.
function urlPossible(src, pos, scanAt) {
  if (src.startsWith('www.', pos)) return true;
  if (schemeAt(src, pos)) return true;
  const c0 = src.charCodeAt(pos) | 32;
  if (c0 === 109 && (src.charCodeAt(pos + 1) | 32) === 97 && (src.charCodeAt(pos + 2) | 32) === 105 &&
      (src.charCodeAt(pos + 3) | 32) === 108 && (src.charCodeAt(pos + 4) | 32) === 116 &&
      (src.charCodeAt(pos + 5) | 32) === 111 && src.charCodeAt(pos + 6) === 58) return true; // mailto:
  if (c0 === 120 && (src.charCodeAt(pos + 1) | 32) === 109 && (src.charCodeAt(pos + 2) | 32) === 112 &&
      (src.charCodeAt(pos + 3) | 32) === 112 && src.charCodeAt(pos + 4) === 58) return true; // xmpp:
  if (!scanAt) return false;
  for (let i = pos; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 64) return true; // @
    const localOk = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      c === 46 || c === 95 || c === 43 || c === 45;
    if (!localOk) return false;
  }
  return false;
}

// Collect every autolink / hard-break stop candidate of `src` in one
// pass: for each match of the stops pattern, the position where a
// plain-text token would have to stop, or nothing when the match can
// never stop one. The candidates come out in match order, and their
// stop positions are non-decreasing in that order, so a plain-text
// scanner that walks the source left to right can consume them with a
// single moving pointer instead of re-scanning with the regex at every
// text token. (The old loop's per-match break conditions only skip work
// that cannot lower the stop any further, so taking the first valid
// candidate in range gives the same answer.)
// Entry: { j: match position, k: first char code of the match,
//   v: email-local run start (for '@'), ok: wwwAt result (for 'www.') }.
// For '://' the scheme start is derived at use time: it depends on the
// token's start, which the collector does not know.
function buildStops(src, mask) {
  const stops = [];
  const rx = stopsRx(mask);
  rx.lastIndex = 0;
  let m;
  while ((m = rx.exec(src)) !== null) {
    const j = m.index;
    const first = m[0].charCodeAt(0);
    if (first === 58) { // '://'
      stops.push({ j, k: 58 });
    } else if (first === 64) { // '@' — stop at the email local part's start
      let s = j;
      while (s > 0 && IS_MAIL_LOCAL[src.charCodeAt(s - 1)]) s--;
      stops.push({ j, k: 64, v: s });
    } else if (first === 119) { // 'www.'
      stops.push({ j, k: 119, ok: wwwAt(src, j) });
    } else if (first === 109 || first === 120) { // 'mailto:' / 'xmpp:'
      stops.push({ j, k: first });
    } else { // '  +\n' — stop at the first space of the hard-break run
      stops.push({ j, k: 32 });
    }
  }
  return stops;
}

// End index of the plain-text token starting at src[i]: a hand-written
// equivalent of the reference text regex. The first character (or a
// backtick / tilde run) is always consumed; the scan then stops before
// any inline-construct trigger, autolink trigger, or hard break, or just
// after the single character before one of those. `flags` are the cheap
// necessary conditions computed once per inline source (whether it
// contains '@', '://', 'www.', 'mailto:'/'xmpp:' or '  \n' at all), so
// the per-character loop only tests what could possibly fire.
function plainEnd(src, i, flags) {
  const n = src.length;
  if (i >= n) return i;
  // A lone non-alphanumeric character before mailto: / xmpp: is its own token.
  if (!IS_ALNUM[src.charCodeAt(i)] &&
      (src.startsWith('mailto:', i + 1) || src.startsWith('xmpp:', i + 1))) return i + 1;
  let p = i;
  const c0 = src.charCodeAt(i);
  if (c0 === 96) {
    while (p < n && src.charCodeAt(p) === 96) p++;
  } else if (c0 === 126) {
    while (p < n && src.charCodeAt(p) === 126) p++;
  } else {
    p = i + 1;
  }
  if (p >= n) return n;
  // Next trigger character (or end of string).
  RX_TRIGGER.lastIndex = p;
  const tm = RX_TRIGGER.exec(src);
  const T = tm ? tm.index : n;
  // No autolink or hard-break stop can fire anywhere in this source: the
  // token ends at the next trigger character.
  if (!flags.hasAutolink) return T;
  let stop = T;
  if (T > p && flags.stops) {
    // The stops were collected once for the whole source, in match
    // order with non-decreasing stop positions; walk them with the
    // moving pointer (the scan only ever moves forward), taking the
    // first valid candidate that starts before T.
    const stops = flags.stops;
    let si = flags.si;
    while (si < stops.length && stops[si].j < p) si++;
    while (si < stops.length && stops[si].j < T) {
      const e = stops[si];
      let c = -1;
      if (e.k === 58) { // '://' — a scheme starts 3-5 chars before it
        for (let d = 5; d >= 3; d--) {
          const q = e.j - d;
          if (q >= p && schemeAt(src, q)) { c = q; break; }
        }
      } else if (e.k === 64) { // '@' — stop at the email local part's start
        const s = p > e.v ? p : e.v;
        if (s < e.j) c = s;
      } else if (e.k === 119) { // 'www.'
        if (e.ok) c = e.j;
      } else if (e.k === 109 || e.k === 120) { // 'mailto:' / 'xmpp:'
        if (e.j > p && !IS_ALNUM[src.charCodeAt(e.j - 1)]) c = e.j;
      } else { // '  +\n' — stop at the first space of the hard-break run
        c = e.j;
      }
      if (c !== -1) { stop = c; break; }
      si++;
    }
    flags.si = si;
  }
  // An email local-part run may cross the trigger at T (its '@' sits
  // after T while the local part starts before it). That can only happen
  // when the trigger character itself is an email-local character.
  if (flags.hasAt && stop > p && T < n && IS_MAIL_LOCAL[src.charCodeAt(T)]) {
    let j = T;
    while (j < n && IS_MAIL_LOCAL[src.charCodeAt(j)]) j++;
    if (j < n && src.charCodeAt(j) === 64) {
      let s = j;
      while (s > p && IS_MAIL_LOCAL[src.charCodeAt(s - 1)]) s--;
      if (s < stop) stop = s;
    }
  }
  return stop;
}
function buildLink(doc, m, ref, raw) {
  const rawLabel = m[1].includes('\\') ? m[1].replace(/\\([\[\]])/g, '$1') : m[1];
  const image = m[0].charAt(0) === '!';
  const savedInLink = doc.st.inLink;
  const savedEmitted = doc.st.linkEmitted;
  const savedRawBlock = doc.st.inRawBlock;
  doc.st.inLink = true;
  doc.st.linkEmitted = false;
  if (image) {
    // An image label never becomes HTML: only its plain text is used,
    // as the alt attribute. In plain mode the whole image is just that
    // alt text.
    const altText = doc.tokenizeInlinePlain(rawLabel);
    doc.st.linkEmitted = savedEmitted;
    doc.st.inLink = savedInLink;
    if (doc.plain) return altText;
    const safe = sanitizeHref(ref.href);
    if (safe === null) return escapeHtml(altText);
    const titleAttr = ref.title ? ` title="${escapeHtml(ref.title)}"` : '';
    return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(altText)}"${titleAttr}>`;
  }
  const innerHtml = doc.plain ? doc.tokenizeInlinePlain(rawLabel) : doc.tokenizeInline(rawLabel);
  const labelMadeLink = doc.st.linkEmitted;
  doc.st.linkEmitted = savedEmitted;
  doc.st.inLink = savedInLink;
  if (labelMadeLink) {
    doc.st.inRawBlock = savedRawBlock;
    return undefined;
  }
  doc.st.linkEmitted = true;
  if (doc.plain) return innerHtml;
  const safe = sanitizeHref(ref.href);
  if (safe === null) return innerHtml;
  const titleAttr = ref.title ? ` title="${escapeHtml(ref.title)}"` : '';
  return `<a href="${escapeHtml(safe)}"${titleAttr}>${innerHtml}</a>`;
}

// Flanking class of a single code point, for the emphasis /
// strikethrough closer scan: 0 means a word character (neither
// punctuation nor whitespace), 1 means punctuation or symbol, 2 means
// whitespace. `~` is a symbol, so it counts as punctuation — except for
// `*` closers, whose grammar excludes `~` from punctuation (it is the
// strikethrough delimiter there).
const FLANK_CLASS = new Uint8Array(128);
for (let c = 9; c <= 13; c++) FLANK_CLASS[c] = 2;
FLANK_CLASS[32] = 2;
for (let c = 33; c <= 47; c++) FLANK_CLASS[c] = 1;
for (let c = 58; c <= 64; c++) FLANK_CLASS[c] = 1;
for (let c = 91; c <= 96; c++) FLANK_CLASS[c] = 1;
for (let c = 123; c <= 126; c++) FLANK_CLASS[c] = 1;
const RX_WS = /\s/u;

// Flanking class of the code point ending just before index `i` of `s`.
// `ast` selects the `*` grammar, where `~` counts as a word character.
// Non-ASCII code points fall back to the Unicode tests.
function flankBefore(s, i, ast) {
  const code = s.charCodeAt(i - 1);
  if (code < 128) {
    if (ast && code === 126) return 0;
    return FLANK_CLASS[code];
  }
  const ch = code >= 0xDC00 && code <= 0xDFFF ? s.slice(i - 2, i) : s[i - 1];
  if (RX_WS.test(ch)) return 2;
  return RX_PUNCT.test(ch) ? 1 : 0;
}

// Flanking class of the code point starting at index `i` of `s`.
function flankAfter(s, i, ast) {
  const code = s.charCodeAt(i);
  if (code < 128) {
    if (ast && code === 126) return 0;
    return FLANK_CLASS[code];
  }
  const ch = code >= 0xD800 && code <= 0xDBFF ? s.slice(i, i + 2) : s[i];
  if (RX_WS.test(ch)) return 2;
  return RX_PUNCT.test(ch) ? 1 : 0;
}

// Which closer group (1-6) a delimiter run belongs to, from the
// flanking classes of the characters before (`b`) and after (`a`) it
// (0 word, 1 punct, 2 space, 3 end of string); 0 when the run is
// neither open-only nor a closer here. The six groups are the
// alternatives of the closer regexes, in order:
//   1 before punct, after space/end — closer (if it may close)
//   2 before word, after punct/space/end — closer (if it may close)
//   3 before punct/space, after word — open-only
//   4 before space, after punct — open-only
//   5 before punct, after punct — closer
//   6 before word, after word — closer (`*` and `~` only; `_` has none,
//     so `both` is false for it)
function closerGroup(b, a, both) {
  if (b === 0) {
    if (a === 1 || a === 2 || a === 3) return 2;
    if (both && a === 0) return 6;
    return 0;
  }
  if (b === 1) {
    if (a === 2 || a === 3) return 1;
    if (a === 0) return 3;
    if (a === 1) return 5;
    return 0;
  }
  // b === 2
  if (a === 0) return 3;
  if (a === 1) return 4;
  return 0;
}

// Last possible `*` / `_` closer position in `masked`, from the cached
// mask entry when it matches, else by scanning.
function emCloserAt(doc, masked, delim) {
  const top = doc.masks[doc.masks.length - 1];
  if (top && top.text === masked) return top.em[delim];
  return findClosers(masked).em[delim];
}

// Last possible `~` closer position in `masked`, cached the same way.
function delCloserAt(doc, masked) {
  const top = doc.masks[doc.masks.length - 1];
  if (top && top.text === masked) return top.del;
  return findClosers(masked).del;
}

// Each try* below returns { html, end } (end = index just past the
// construct in the source; html is its rendered HTML, or its plain text
// when scanning in plain mode) or undefined when the construct does not
// start at pos.

function tryInlineLink(doc, src, pos, flags) {
  if (doc.st.linkParenOk === false) return undefined;
  // An inline link's label must be followed by '(': without '](' anywhere
  // in the source the big label regex cannot match. (Computed once per
  // source in `flags`, not per call.)
  if (!flags.hasInlineLink) return undefined;
  const rx = IGY.link;
  rx.lastIndex = pos;
  const m = rx.exec(src);
  if (!m) return undefined;
  const labelAt = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelOpensTag(src, m[1], pos + labelAt, IG)) return undefined;
  const hrefPart = m[2].trim();
  if (RX.startAngle.test(hrefPart)) {
    if (!RX.endAngle.test(hrefPart)) return undefined;
    const stripped = trimTail(hrefPart.slice(0, -1), '\\');
    if ((hrefPart.length - stripped.length) % 2 === 0) return undefined;
  } else {
    const bal = parenDepth(m[2], '()');
    if (bal === -2) return undefined;
    if (bal > -1) {
      const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + bal;
      m[2] = m[2].substring(0, bal);
      m[0] = m[0].substring(0, cut).trim();
      m[3] = '';
    }
  }
  const noTrail = trimTail(m[0].slice(0, -1), '\\');
  if ((m[0].length - noTrail.length) % 2 === 0) return undefined;
  let href = m[2].trim();
  const title = m[3] ? m[3].slice(1, -1) : '';
  if (RX.startAngle.test(href)) href = href.slice(1, -1);
  const html = buildLink(doc, m, {
    href: href && (href.includes('\\') ? href.replace(IG.anyPunct, '$1') : href),
    title: title && (title.includes('\\') ? title.replace(IG.anyPunct, '$1') : title),
  }, m[0]);
  if (html === undefined) return undefined;
  return { html, end: pos + m[0].length };
}

function tryRefLink(doc, src, pos, flags) {
  let rx = IGY.reflink;
  rx.lastIndex = pos;
  let m = rx.exec(src);
  if (!m) {
    rx = IGY.nolink;
    rx.lastIndex = pos;
    m = rx.exec(src);
  }
  if (!m) return undefined;
  const labelAt = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelOpensTag(src, m[1], pos + labelAt, IG)) return undefined;
  const ref = doc.links[doc.foldLabel(m[2] || m[1])];
  if (!ref) {
    // an unresolved reference is just its first character as text
    const first = m[0].charAt(0);
    return { html: first, end: pos + 1 };
  }
  const html = buildLink(doc, m, ref, m[0]);
  if (html === undefined) return undefined;
  return { html, end: pos + m[0].length };
}

function tryEmphasis(doc, src, pos, masked, prev) {
  const rx = IGY.emStrongL;
  rx.lastIndex = pos;
  const m = rx.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return undefined;
  const delim = m[0][0];
  const prevSame = prev === delim;
  const offset = pos;
  let runStart = offset;
  while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
  const charBefore = runStart > 0 ? cpBefore(masked, runStart) : '';
  const beforeIsPunct = charBefore === '*' || charBefore === '_' || isDelimPunct(charBefore);
  if (runStart < offset) prev = charBefore;
  const prevPunct = runStart < offset ? beforeIsPunct : isDelimPunct(prev);
  // `_` cannot open emphasis when the character before the run is
  // alphanumeric and there is a character after the run
  if (m[4] && isAlnumPrev(prev)) return undefined;
  const afterPunct = m[1] || m[3] || '';
  if (!afterPunct || !prev || prevPunct) {
    // k = the run's length in code points, minus one when no character
    // follows the run (the run is ASCII, so its UTF-16 length is its
    // code-point length; a following character adds exactly one).
    let runLen = 0;
    while (runLen < m[0].length && m[0][runLen] === delim) runLen++;
    const k = runLen - 1 + (m[0].length > runLen ? 1 : 0);
    let openLeft = k;
    let skipped = 0;
    const y = offset - runStart + k;
    const canClose = !!charBefore.trim() && (!!afterPunct || (delim === '*' && !beforeIsPunct));
    if (delim !== '*' && delim !== '_') return undefined;
    const ast = delim === '*';
    const lastCloser = emCloserAt(doc, masked, delim);
    const scanStart = offset + k;
    if (lastCloser < scanStart) return undefined;
    // Walk the delimiter runs with indexOf and classify their
    // flanking directly, instead of running the Unicode closer regex
    // over the whole tail on every attempt. The skip alternative
    // still fires once at scanStart (see mkCloserSkip), then the
    // search walks run to run; a run's "match start" is the
    // character before it, so the raw span below uses
    // runStart - 1 - scanStart as the relative match index.
    const n = masked.length;
    const dc = ast ? 42 : 95;
    let search = scanStart;
    const skipRx = ast ? IG.emStrongSkipAst : IG.emStrongSkipUnd;
    skipRx.lastIndex = scanStart;
    const sm = skipRx.exec(masked);
    if (sm) search = scanStart + sm[0].length;
    for (;;) {
      const rs = masked.indexOf(delim, search);
      if (rs === -1 || rs > lastCloser) break;
      let re = rs + 1;
      while (re < n && masked.charCodeAt(re) === dc) re++;
      const b = re - rs;
      search = re;
      // A run with no preceding character inside the scan range can
      // never be a closer (the regex needs the character before it);
      // it is skipped, exactly as the regex engine skips past it.
      if (rs === scanStart) continue;
      const grp = closerGroup(flankBefore(masked, rs, ast), re >= n ? 3 : flankAfter(masked, re, ast), ast);
      if (!grp) continue;
      if (grp === 3 || grp === 4) {
        // open-only delimiter: it adds to the openers still to be closed
        openLeft += b;
        continue;
      }
      if (grp === 5 || grp === 6 || canClose) {
        if (prevSame && (grp === 5 || grp === 6)) break;
        // the rule of three: a closer whose length plus the opener's
        // length is a multiple of 3 (when the opener's isn't) cannot close
        if (y % 3 && !((y + b) % 3)) {
          skipped += b;
          continue;
        }
      }
      openLeft -= b;
      if (openLeft > 0) continue;
      const use = Math.min(b, b + openLeft + skipped);
      const bc = masked.charCodeAt(rs - 1);
      const firstLen = bc >= 0xD800 && bc <= 0xDBFF ? 2 : 1;
      const raw = src.slice(pos, pos + k + (rs - 1 - scanStart) + firstLen + use);
      if (Math.min(k, use) % 2) {
        const inner = raw.slice(1, -1);
        const innerHtml = doc.plain ? doc.tokenizeInlinePlain(inner) : doc.tokenizeInline(inner);
        return { html: doc.plain ? innerHtml : `<em>${innerHtml}</em>`, end: pos + raw.length };
      }
      const inner = raw.slice(2, -2);
      const innerHtml = doc.plain ? doc.tokenizeInlinePlain(inner) : doc.tokenizeInline(inner);
      return { html: doc.plain ? innerHtml : `<strong>${innerHtml}</strong>`, end: pos + raw.length };
    }
  }
  return undefined;
}

function tryStrike(doc, src, pos, masked, prev) {
  const rx = IGY.delL;
  rx.lastIndex = pos;
  const m = rx.exec(src);
  if (!m) return undefined;
  if (!(m[1] || '') || !prev || isDelimPunct(prev)) {
    // runLen = the run's length in code points, minus one when no
    // character follows the run (the run is ASCII, so its UTF-16 length
    // is its code-point length; a following character adds exactly one).
    let count = 0;
    while (count < m[0].length && m[0][count] === '~') count++;
    const runLen = count - 1 + (m[0].length > count ? 1 : 0);
    let openLeft = runLen;
    const lastCloser = delCloserAt(doc, masked);
    const scanStart = pos + runLen;
    if (lastCloser < scanStart) return undefined;
    // Same hand-written run walk as tryEmphasis: the skip alternative
    // fires once at scanStart, then indexOf walks run to run.
    const n = masked.length;
    let search = scanStart;
    IG.delSkip.lastIndex = scanStart;
    const sm = IG.delSkip.exec(masked);
    if (sm) search = scanStart + sm[0].length;
    for (;;) {
      const rs = masked.indexOf('~', search);
      if (rs === -1 || rs > lastCloser) break;
      let re = rs + 1;
      while (re < n && masked.charCodeAt(re) === 126) re++;
      let l = re - rs;
      search = re;
      if (l !== runLen) continue;
      if (rs === scanStart) continue;
      const grp = closerGroup(flankBefore(masked, rs, false), re >= n ? 3 : flankAfter(masked, re, false), true);
      if (!grp) continue;
      if (grp === 3 || grp === 4) {
        openLeft += l;
        continue;
      }
      openLeft -= l;
      if (openLeft > 0) continue;
      l = Math.min(l, l + openLeft);
      const bc = masked.charCodeAt(rs - 1);
      const firstLen = bc >= 0xD800 && bc <= 0xDBFF ? 2 : 1;
      const raw = src.slice(pos, pos + runLen + (rs - 1 - scanStart) + firstLen + l);
      const inner = raw.slice(runLen, -runLen);
      const innerHtml = doc.plain ? doc.tokenizeInlinePlain(inner) : doc.tokenizeInline(inner);
      return { html: doc.plain ? innerHtml : `<del>${innerHtml}</del>`, end: pos + raw.length };
    }
  }
  return undefined;
}

function tryCodeSpan(src, pos, plain) {
  if (src.indexOf('`', pos + 1) === -1) return undefined;
  const rx = IGY.code;
  rx.lastIndex = pos;
  const m = rx.exec(src);
  if (!m) return undefined;
  let text = m[2].replace(RX.newlineGlobal, ' ');
  const hasNonSpace = RX.nonSpace.test(text);
  const wrapped = text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ';
  if (hasNonSpace && wrapped) text = text.substring(1, text.length - 1);
  return { html: plain ? text : `<code>${escapeHtml(text, true)}</code>`, end: pos + m[0].length };
}

function tryAutolink(src, pos, plain) {
  const rx = IGY.autolink;
  rx.lastIndex = pos;
  const m = rx.exec(src);
  if (!m) return undefined;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[1];
    href = 'mailto:' + text;
  } else {
    text = m[1];
    href = text;
  }
  if (plain) return { html: text, end: pos + m[0].length };
  const cleaned = sanitizeHref(href);
  if (cleaned === null) return { html: escapeHtml(text, true), end: pos + m[0].length };
  return { html: `<a href="${escapeHtml(cleaned, true)}">${escapeHtml(text, true)}</a>`, end: pos + m[0].length };
}

function tryExtUrl(src, pos, plain) {
  const rx = IGY.url;
  rx.lastIndex = pos;
  const m = rx.exec(src);
  if (!m) return undefined;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let cur = m[0];
    for (;;) {
      const back = IG.urlBackpedal.exec(cur)?.[0] ?? '';
      if (back === cur) break;
      cur = back;
    }
    text = cur;
    href = m[1] === 'www.' ? 'http://' + cur : cur;
  }
  if (plain) return { html: text, end: pos + text.length };
  const cleaned = sanitizeHref(href);
  if (cleaned === null) return { html: escapeHtml(text, true), end: pos + text.length };
  return { html: `<a href="${escapeHtml(cleaned, true)}">${escapeHtml(text, true)}</a>`, end: pos + text.length };
}

function tryHtmlTag(doc, src, pos) {
  const rx = IGY.tag;
  rx.lastIndex = pos;
  const m = rx.exec(src);
  if (!m) return undefined;
  if (!doc.st.inLink && RX.startATag.test(m[0])) doc.st.inLink = true;
  else if (doc.st.inLink && RX.endATag.test(m[0])) doc.st.inLink = false;
  if (!doc.st.inRawBlock && RX.startPreTag.test(m[0])) doc.st.inRawBlock = true;
  else if (doc.st.inRawBlock && RX.endPreTag.test(m[0])) doc.st.inRawBlock = false;
  // A raw tag contributes its literal text in both modes.
  return { html: m[0], end: pos + m[0].length };
}
// Count of leading space characters (tabs are never leading here: they
// are expanded to spaces before this is called, or count as content).
function leadingSpaces(s) {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 32) i++;
  return i;
}

// True when a line holds only spaces and tabs.
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// True when `s` ends with a blank line: a newline, optional spaces/tabs,
// another newline, optional spaces/tabs, end of string.
function endsWithDoubleBlank(s) {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  if (i === 0 || s[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  return i > 0 && s[i - 1] === '\n';
}

// Would any of the list-item break tests match this line? Every one of
// them is anchored with up to `maxLead` spaces, so one can only match
// when the first non-space character (a tab or too much indent ends the
// search) starts a block construct; otherwise all six are skipped. Each
// regex can only match when that first character is its own, so only the
// regexes for that character are attempted.
function lineBreaksItem(line, maxLead, fenceRx, headingRx, htmlRx, quoteRx, bulletRx, hrRx) {
  for (let i = 0; i <= maxLead; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) continue;
    switch (c) {
      case 96: case 126: return fenceRx.test(line);
      case 35: return headingRx.test(line);
      case 60: return htmlRx.test(line);
      case 62: return quoteRx.test(line);
      case 42: case 45: return bulletRx.test(line) || hrRx.test(line);
      case 43: return bulletRx.test(line);
      case 95: return hrRx.test(line);
      default:
        if (c >= 48 && c <= 57) return bulletRx.test(line);
        return false;
    }
  }
  return false;
}

// Same dispatch for the previous-line break tests in listTok: only the
// regex whose construct can start with the line's first non-space
// character is attempted.
function prevLineBreaksItem(s, fenceRx, headingRx, htmlRx, hrRx) {
  const c = firstNonSpaceChar(s);
  if (c === 96 || c === 126) return fenceRx.test(s);
  if (c === 35) return headingRx.test(s);
  if (c === 60) return htmlRx.test(s);
  if (c === 45 || c === 95 || c === 42) return hrRx.test(s);
  return false;
}

// Visual width of the leading whitespace run of `s`: a space counts 1,
// a tab counts 4 (the width the tab-to-spaces expansion gives it).
function leadingWidth(s) {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32) w++;
    else if (c === 9) w += 4;
    else break;
  }
  return w;
}

// First non-space character within the first four positions of `src`
// (-1 when there is none). Block constructs allow at most three leading
// spaces, so a construct can only start when this character is its own.
function firstNonSpaceChar(src) {
  for (let i = 0; i < 4 && i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 32) continue;
    return c;
  }
  return -1;
}

// Could `src` hold a table? The second line must be a delimiter row: at
// most three leading spaces, then only pipes, colons, dashes, spaces and
// tabs, with at least one dash.
function maybeTable(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  let j = nl + 1;
  while (j < src.length && src[j] === ' ' && j - (nl + 1) < 3) j++;
  let hasDash = false;
  let k = j;
  while (k < src.length && src[k] !== '\n') {
    const ch = src[k];
    if (ch === '-') hasDash = true;
    else if (ch !== '|' && ch !== ':' && ch !== ' ' && ch !== '\t') return false;
    k++;
  }
  return hasDash;
}

// Could `src` hold a setext heading? Some line after the first, before
// the first blank line, must look like an underline: at most three
// spaces, then only '=' or '-' (and spaces/tabs) to the end of the line.
function maybeSetext(src) {
  let pos = src.indexOf('\n');
  if (pos === -1) return false;
  pos++;
  while (pos < src.length) {
    let j = pos;
    while (j < src.length && src[j] === ' ' && j - pos < 3) j++;
    const c = src[j];
    if (c === '=' || c === '-') {
      let k = j;
      let ok = true;
      while (k < src.length) {
        const ch = src[k];
        if (ch === '=' || ch === '-' || ch === ' ' || ch === '\t') k++;
        else if (ch === '\n') break;
        else { ok = false; break; }
      }
      if (ok && (k === src.length || src[k] === '\n')) return true;
    }
    const nl = src.indexOf('\n', pos);
    const end = nl === -1 ? src.length : nl;
    let blank = true;
    for (let p = pos; p < end; p++) {
      if (src[p] !== ' ' && src[p] !== '\t') { blank = false; break; }
    }
    if (blank) return false;
    if (nl === -1) return false;
    pos = nl + 1;
  }
  return false;
}

function fenceDedent(raw, code) {
  const m = raw.match(RX.fenceIndent);
  if (m === null) return code;
  const indent = m[1];
  return code.split('\n').map((line) => {
    const sp = line.match(RX.leadingSpaces);
    if (sp === null) return line;
    return line.slice(Math.min(sp[0].length, indent.length));
  }).join('\n');
}
/* ------------------------------------------------------------------ */
/* the parser                                                          */
/* ------------------------------------------------------------------ */

class Parser {
  constructor() {
    this.toks = [];
    this.toks.links = Object.create(null);
    this.hasLinks = false;
    this.st = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenOk: true, top: true };
    this.queue = [];
    this.masks = [];
    this.labelCache = new Map();
    // True while scanning for plain text (image alt text): constructs
    // emit their text content instead of HTML.
    this.plain = false;
  }

  get links() {
    return this.toks.links;
  }

  // Memoized label normalization: reference labels repeat heavily, and
  // the fold (trim + whitespace collapse + case fold) is pure, so the
  // cache is per-parse and never crosses cases.
  foldLabel(s) {
    const cache = this.labelCache;
    const hit = cache.get(s);
    if (hit !== undefined) return hit;
    const folded = foldLabel(s);
    cache.set(s, folded);
    return folded;
  }

  // Queue an inline source to be rendered to HTML after the block pass.
  // The block pass must finish first because a link definition may
  // appear after its use; the rendered HTML is written onto `target`.
  queueInline(src, target) {
    this.queue.push({ src, target });
  }

  run(src) {
    if (src.includes('\r')) src = src.replace(RX.crlf, '\n');
    this.tokenizeBlocks(src, this.toks);
    for (let qi = 0; qi < this.queue.length; qi++) {
      const item = this.queue[qi];
      this.st.inRawBlock = false;
      item.target.html = this.tokenizeInline(item.src);
    }
    this.queue = [];
    return this.toks;
  }

  // Render an inline source straight to HTML, with no token tree: the
  // scanner appends each construct's HTML to one string. Returns '' for
  // an empty source.
  tokenizeInline(src) {
    if (!src) return '';
    // Fast path: plain text with no inline construct, no escapable
    // character and no autolink trigger is returned verbatim, in both
    // modes (it needs no escaping and no decoding: `&` forces the slow
    // path, so no `&#...;` can hide here).
    if (!RX_PLAIN_INLINE.test(src)) return src;
    const savedParen = this.st.linkParenOk;
    this.st.linkParenOk = savedParen && src.includes(')');
    try {
      // includes() substring search beats the equivalent regex tests
      // here (measured ~2x on real paragraphs).
      const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
      const masked = hasDelim ? maskSource(src, this) : src;
      // Without an emphasis delimiter there can be no closer, so the
      // scan is skipped; the pushed entry still carries the masked text
      // so the closer lookup matches it instead of re-scanning.
      this.masks.push(hasDelim ? findClosers(masked) : { text: src, em: NO_CLOSERS_EM, del: -1 });
      // Cheap necessary conditions for the plain-text scanner's autolink
      // and hard-break stops, computed once for the whole source:
      // whether any stop pattern occurs at all, whether '@' occurs (an
      // email local part may start before the next trigger character),
      // and whether an inline link `](` occurs at all (the link
      // tokenizer's per-call scan otherwise re-scans the whole rest of
      // the source on every `[`).
      const hasAt = src.includes('@');
      const stopMask = (src.includes('://') ? 1 : 0)
        | (src.includes('www.') ? 2 : 0)
        | (src.includes('mailto:') ? 4 : 0)
        | (src.includes('xmpp:') ? 8 : 0)
        | (hasAt ? 16 : 0)
        | (src.includes('  \n') ? 32 : 0);
      const flags = {
        hasAt,
        hasAutolink: stopMask !== 0,
        hasInlineLink: src.includes(']('),
        // Autolink / hard-break stops, collected once per source (see
        // buildStops); `si` is the moving pointer into that list.
        stops: null,
        si: 0,
      };
      if (stopMask) flags.stops = buildStops(src, stopMask);
      // The mask stack is popped right after the scan: if the scan
      // throws, the whole parse aborts and this Parser is discarded, so
      // no cleanup is needed on that path.
      const result = this.scanInline(src, masked, flags);
      this.masks.pop();
      return result;
    } finally {
      this.st.linkParenOk = savedParen;
    }
  }

  // Plain-text rendering of an inline source, used for image alt text:
  // no tags, no escaping, line breaks vanish. Shares the scanner with
  // tokenizeInline, with `plain` set for its duration.
  tokenizeInlinePlain(src) {
    if (!src) return '';
    const wasPlain = this.plain;
    this.plain = true;
    try {
      return this.tokenizeInline(src);
    } finally {
      this.plain = wasPlain;
    }
  }

  scanInline(src, masked, flags) {
    const n = src.length;
    let pos = 0;
    let out = '';
    let lastWasText = false;
    let prevCh = '';
    while (pos < n) {
      if (!lastWasText) prevCh = '';
      lastWasText = false;
      // Dispatch on the first character: at most two inline constructs
      // can start with any given character, so most attempts are
      // skipped.
      const c = src.charCodeAt(pos);
      let hit;
      if (c === 92) { // backslash: escape, or a backslash hard break
        IGY.escape.lastIndex = pos;
        const m = IGY.escape.exec(src);
        if (m) {
          out += this.plain ? m[1] : escapeHtml(m[1]);
          pos += m[0].length;
          continue;
        }
        IGY.br.lastIndex = pos;
        const b = IGY.br.exec(src);
        if (b) {
          if (!this.plain) out += '<br>';
          pos += b[0].length;
          continue;
        }
      } else if (c === 60) { // <: raw HTML tag or autolink
        hit = tryHtmlTag(this, src, pos);
        if (hit) {
          out += hit.html;
          pos = hit.end;
          continue;
        }
        hit = tryAutolink(src, pos, this.plain);
        if (hit) {
          out += hit.html;
          pos = hit.end;
          continue;
        }
      } else if (c === 91 || c === 33) { // [ or !: link or reference link
        hit = tryInlineLink(this, src, pos, flags);
        if (hit) {
          out += hit.html;
          pos = hit.end;
          continue;
        }
        hit = tryRefLink(this, src, pos, flags);
        if (hit) {
          out += hit.html;
          pos = hit.end;
          continue;
        }
      } else if (c === 96) { // backtick: code span
        hit = tryCodeSpan(src, pos, this.plain);
        if (hit) {
          out += hit.html;
          pos = hit.end;
          continue;
        }
      } else if (c === 42 || c === 95) { // * or _: emphasis
        hit = tryEmphasis(this, src, pos, masked, prevCh);
        if (hit) {
          out += hit.html;
          pos = hit.end;
          continue;
        }
        // An email address can start with '_' (its local part allows
        // it), so a failed emphasis attempt must still try the extended
        // autolink, as the reference dispatch does after emStrong.
        if (c === 95 && !this.st.inLink && urlPossible(src, pos, flags.hasAt)) {
          hit = tryExtUrl(src, pos, this.plain);
          if (hit) {
            out += hit.html;
            pos = hit.end;
            continue;
          }
        }
      } else if (c === 126) { // ~: strikethrough
        hit = tryStrike(this, src, pos, masked, prevCh);
        if (hit) {
          out += hit.html;
          pos = hit.end;
          continue;
        }
      } else if (c === 32) { // space: two-space hard break
        IGY.br.lastIndex = pos;
        const b = IGY.br.exec(src);
        if (b) {
          if (!this.plain) out += '<br>';
          pos += b[0].length;
          continue;
        }
      } else if (!this.st.inLink && urlPossible(src, pos, flags.hasAt)) {
        hit = tryExtUrl(src, pos, this.plain);
        if (hit) {
          out += hit.html;
          pos = hit.end;
          continue;
        }
      }
      // Plain text: find the token end, slice it once, unescape, and
      // append it — escaped, unless inside a raw block or in plain mode
      // (where the text is used as-is). decodeRefs is the identity
      // without '&#' and escapeHtml is the identity without any of
      // &<>"', so one RX_ESC_TEST covers both: a token with no such
      // character skips both calls entirely.
      const end = plainEnd(src, pos, flags);
      if (end > pos) {
        const chunk = src.slice(pos, end);
        const inRaw = this.st.inRawBlock;
        let text;
        if (inRaw) text = chunk;
        else if (!RX_ESC_TEST.test(chunk)) text = chunk;
        else if (this.plain) text = decodeRefs(chunk);
        else text = escapeHtml(decodeRefs(chunk));
        pos = end;
        if (chunk.charCodeAt(chunk.length - 1) !== 95) prevCh = chunk.charAt(chunk.length - 1);
        lastWasText = true;
        out += text;
        continue;
      }
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    }
    return out;
  }
  tokenizeBlocks(src, out, inBlock = false) {
    let minLen = Infinity;
    while (src) {
      if (src.length < minLen) minLen = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let tok;
      // First character of the remaining source: most block constructs
      // can only start with one specific character (after at most three
      // leading spaces), so their regexes are only attempted when that
      // character could possibly be there.
      const first = firstNonSpaceChar(src);
      const head = src.charCodeAt(0);
      if ((head === 32 || head === 9 || head === 10) && (tok = this.blankTok(src))) {
        src = src.slice(tok.raw.length);
        const last = out[out.length - 1];
        if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
        else out.push(tok);
        continue;
      }
      if ((head === 32 || head === 9) && (tok = this.indentedTok(src))) {
        src = src.slice(tok.raw.length);
        const last = out[out.length - 1];
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.queue[this.queue.length - 1].src = last.text;
        } else out.push(tok);
        continue;
      }
      // Cheap necessary conditions, so the big regexes below only run
      // when they could possibly match.
      if ((first === 96 || first === 126) && (tok = this.fenceTok(src))) {
        src = src.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      if (first === 35 && (tok = this.headTok(src))) {
        src = src.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      if ((first === 45 || first === 95 || first === 42) && (tok = this.ruleTok(src))) {
        src = src.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      if (first === 62 && (tok = this.quoteTok(src))) {
        src = src.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      if ((first === 42 || first === 43 || first === 45 || (first >= 48 && first <= 57)) && (tok = this.listTok(src))) {
        src = src.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      if (first === 60 && (tok = this.htmlBlockTok(src))) {
        src = src.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      if (first === 91 && (tok = this.defTok(src))) {
        src = src.slice(tok.raw.length);
        const last = out[out.length - 1];
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.raw;
          this.queue[this.queue.length - 1].src = last.text;
        } else {
          if (!this.toks.links[tok.tag]) {
            this.toks.links[tok.tag] = { href: tok.href, title: tok.title };
            this.hasLinks = true;
          }
          out.push(tok);
        }
        continue;
      }
      if (maybeTable(src) && (tok = this.tableTok(src))) {
        src = src.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      if (maybeSetext(src) && (tok = this.setextTok(src))) {
        src = src.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      if (this.st.top && (tok = this.paraTok(src))) {
        const last = out[out.length - 1];
        if (inBlock && last?.type === 'paragraph') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.queue.pop();
          this.queue[this.queue.length - 1].src = last.text;
        } else out.push(tok);
        inBlock = false;
        src = src.slice(tok.raw.length);
        continue;
      }
      if (tok = this.textTok(src)) {
        src = src.slice(tok.raw.length);
        const last = out[out.length - 1];
        if (last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.queue.pop();
          this.queue[this.queue.length - 1].src = last.text;
        } else out.push(tok);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.st.top = true;
    return out;
  }

  blankTok(src) {
    const mm = BG.newline.exec(src);
    if (mm && mm[0].length > 0) return { type: 'space', raw: mm[0] };
    return undefined;
  }

  indentedTok(src) {
    const mm = BG.indentedCode.exec(src);
    if (!mm) return undefined;
    const raw = dropTrailingBlanks(mm[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(RX.codeRemoveIndent, '') };
  }

  fenceTok(src) {
    const mm = BG.fences.exec(src);
    if (!mm) return undefined;
    const lang = mm[2] ? mm[2].trim().replace(IG.anyPunct, '$1') : mm[2];
    return { type: 'code', raw: mm[0], lang, text: fenceDedent(mm[0], mm[3] || '') };
  }

  headTok(src) {
    const mm = BG.heading.exec(src);
    if (!mm) return undefined;
    let text = mm[2].trim();
    if (RX.endingHash.test(text)) {
      const stripped = trimTail(text, '#');
      if (!stripped || RX.endsSpaceTab.test(stripped)) text = stripped.trim();
    }
    const tok = { type: 'heading', raw: trimTail(mm[0], '\n'), depth: mm[1].length, text };
    this.queueInline(text, tok);
    return tok;
  }

  ruleTok(src) {
    const mm = BG.hr.exec(src);
    if (!mm) return undefined;
    return { type: 'hr', raw: trimTail(mm[0], '\n') };
  }

  htmlBlockTok(src) {
    const mm = BG.html.exec(src);
    if (!mm) return undefined;
    const raw = dropTrailingBlanks(mm[0]);
    return {
      type: 'html', block: true, raw,
      pre: mm[1] === 'pre' || mm[1] === 'script' || mm[1] === 'style',
      text: raw,
    };
  }

  defTok(src) {
    const mm = BG.def.exec(src);
    if (!mm) return undefined;
    if (!RX.startAngle.test(mm[2]) && parenDepth(mm[2], '()') !== -1) return undefined;
    const tag = this.foldLabel(mm[1]);
    const hrefRaw = mm[2] ? mm[2].replace(RX.hrefBrackets, '$1') : '';
    const href = hrefRaw.includes('\\') ? hrefRaw.replace(IG.anyPunct, '$1') : hrefRaw;
    const titleRaw = mm[3] ? mm[3].substring(1, mm[3].length - 1) : mm[3];
    const title = titleRaw && titleRaw.includes('\\') ? titleRaw.replace(IG.anyPunct, '$1') : titleRaw;
    return { type: 'def', tag, raw: trimTail(mm[0], '\n'), href, title };
  }

  tableTok(src) {
    const mm = BG.table.exec(src);
    if (!mm || !RX.tablePipe.test(mm[2])) return undefined;
    const headerCells = splitRowCells(mm[1]);
    const aligns = mm[2].replace(RX.tableEdge, '').split('|');
    const bodyRows = mm[3]?.trim() ? mm[3].replace(RX.tableRowBlank, '').split('\n') : [];
    const table = { type: 'table', raw: trimTail(mm[0], '\n'), header: [], align: [], rows: [] };
    if (headerCells.length !== aligns.length) return undefined;
    for (const a of aligns) {
      if (RX.tableRight.test(a)) table.align.push('right');
      else if (RX.tableCenter.test(a)) table.align.push('center');
      else if (RX.tableLeft.test(a)) table.align.push('left');
      else table.align.push(null);
    }
    for (let i = 0; i < headerCells.length; i++) {
      const cell = { text: headerCells[i], header: true, align: table.align[i] };
      this.queueInline(headerCells[i], cell);
      table.header.push(cell);
    }
    for (const row of bodyRows) {
      table.rows.push(splitRowCells(row, table.header.length).map((cell, j) => {
        const c = { text: cell, header: false, align: table.align[j] };
        this.queueInline(cell, c);
        return c;
      }));
    }
    return table;
  }

  setextTok(src) {
    const mm = BG.setext.exec(src);
    if (!mm) return undefined;
    const text = mm[1].trim();
    const tok = {
      type: 'heading', raw: trimTail(mm[0], '\n'),
      depth: mm[2].charAt(0) === '=' ? 1 : 2,
      text,
    };
    this.queueInline(text, tok);
    return tok;
  }

  paraTok(src) {
    const mm = BG.paragraph.exec(src);
    if (!mm) return undefined;
    const lastCh = mm[1].charAt(mm[1].length - 1);
    const text = lastCh === '\n' ? mm[1].slice(0, -1) : mm[1];
    const tok = { type: 'paragraph', raw: mm[0], text };
    this.queueInline(text, tok);
    return tok;
  }

  textTok(src) {
    const mm = BG.text.exec(src);
    if (!mm) return undefined;
    const tok = { type: 'text', raw: mm[0], text: mm[0] };
    this.queueInline(mm[0], tok);
    return tok;
  }
  quoteTok(src) {
    const mm = BG.blockquote.exec(src);
    if (!mm) return undefined;
    let pending = trimTail(mm[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    for (; pending.length > 0;) {
      let inside = false;
      const piece = [];
      let p;
      for (p = 0; p < pending.length; p++) {
        if (RX.quoteStart.test(pending[p])) {
          piece.push(pending[p]);
          inside = true;
        } else if (!inside) piece.push(pending[p]);
        else break;
      }
      pending = pending.slice(p);
      const pieceStr = piece.join('\n');
      const innerText = pieceStr
        .replace(RX.quoteMarkerWs, (g, b, ws) => b + expandTabs(ws, b.length))
        .replace(RX.quoteSetext, '\n    $1')
        .replace(RX.quoteStrip, '');
      raw = raw ? `${raw}\n${pieceStr}` : pieceStr;
      text = text ? `${text}\n${innerText}` : innerText;
      const prevTop = this.st.top;
      this.st.top = true;
      this.tokenizeBlocks(innerText, tokens, true);
      this.st.top = prevTop;
      if (pending.length === 0) break;
      const last = tokens[tokens.length - 1];
      if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' ||
          last?.type === 'html' || last?.type === 'table') break;
      if (last?.type === 'blockquote') {
        const prev = last;
        const rest = pending.join('\n');
        const merged = prev.raw + '\n' + rest.replace(RX.quoteStrip, '');
        const reparsed = this.quoteTok(merged);
        tokens[tokens.length - 1] = reparsed;
        const tail = merged.substring(reparsed.raw.length).replace(/^\n/, '');
        const tailLines = tail ? tail.split('\n').length : 0;
        const consumedLines = tailLines ? pending.slice(0, -tailLines) : pending;
        if (consumedLines.length > 0) raw = `${raw}\n${consumedLines.join('\n')}`;
        text = text.substring(0, text.length - prev.text.length) + reparsed.text;
        pending = pending.slice(consumedLines.length);
        if (pending.length > 0 && RX.quoteStart.test(pending[0])) continue;
        break;
      } else if (last?.type === 'list') {
        const prev = last;
        const merged = prev.raw + '\n' + pending.join('\n');
        const reparsed = this.listTok(merged);
        tokens[tokens.length - 1] = reparsed;
        const extra = reparsed.raw.length > prev.raw.length
          ? merged.slice(prev.raw.length + 1, reparsed.raw.length).split('\n').length
          : 0;
        if (extra > 0) {
          const extraLines = pending.slice(0, extra).join('\n');
          raw = `${raw}\n${extraLines}`;
          text = `${text}\n${extraLines}`;
        }
        pending = pending.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  listTok(src) {
    const mm = BG.listStart.exec(src);
    if (!mm) return undefined;
    const fullSrc = src;
    const consumed = () => fullSrc.length - src.length;
    const marker = mm[1].trim();
    const ordered = marker.length > 1;
    const list = {
      type: 'list', raw: '', ordered,
      start: ordered ? +marker.slice(0, -1) : '',
      loose: false, items: [],
    };
    const markerPattern = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
    const itemRx = itemPattern(markerPattern);
    let sawDoubleBlank = false;
    while (src) {
      let blankAfter = false;
      let itemText = '';
      const im = itemRx.exec(src);
      if (!im || BG.hr.test(src)) break;
      const itemStart = consumed();
      src = src.substring(im[0].length);
      const nl2 = im[2].indexOf('\n');
      const firstLine = nl2 === -1 ? im[2] : im[2].slice(0, nl2);
      const markerWidth = im[1].length;
      const firstContent = firstLine.includes('\t')
        ? firstLine.replace(RX.leadingSpaceTab, (v) => expandTabs(v, markerWidth))
        : firstLine;
      const nl3 = src.indexOf('\n');
      const nextLine = nl3 === -1 ? src : src.slice(0, nl3);
      const isEmpty = !firstContent.trim();
      let contentIndent = 0;
      if (isEmpty) {
        contentIndent = markerWidth + 1;
      } else {
        contentIndent = leadingSpaces(firstContent);
        if (contentIndent > 4) contentIndent = 1;
        itemText = firstContent.slice(contentIndent);
        contentIndent += markerWidth;
      }
      if (isEmpty && RX.blankLine.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        blankAfter = true;
      }
      if (!blankAfter) {
        const bulletRx = indentPattern('bullet', contentIndent);
        const hrRx = indentPattern('hr', contentIndent);
        const fenceRx = indentPattern('fences', contentIndent);
        const headingRx = indentPattern('heading', contentIndent);
        const htmlRx = indentPattern('html', contentIndent);
        const quoteRx = indentPattern('blockquote', contentIndent);
        const maxLead = Math.max(0, Math.min(3, contentIndent - 1));
        let prevContent = firstContent;
        let prevLead = leadingWidth(firstContent);
        let blankLine = isEmpty;
        for (; src;) {
          const nl = src.indexOf('\n');
          const line = nl === -1 ? src : src.slice(0, nl);
          if (lineBreaksItem(line, maxLead, fenceRx, headingRx, htmlRx, quoteRx, bulletRx, hrRx)) break;
          // Walk the leading whitespace run once: it tells whether
          // the line is blank, and whether a tab hides in it (only
          // then is the run expanded — the expansion only ever
          // touches the leading run, so a tab elsewhere needs no
          // work, and the whole-line tab scan below is skipped).
          let lead = 0;
          let tabInLead = false;
          for (; lead < line.length; lead++) {
            const c = line.charCodeAt(lead);
            if (c === 32) continue;
            if (c === 9) { tabInLead = true; continue; }
            break;
          }
          let expanded = line;
          if (tabInLead) {
            const head = expandTabs(line.slice(0, lead), 0);
            expanded = head + line.slice(lead);
            lead = head.length;
          }
          const lineBlank = lead === expanded.length;
          const sliced = expanded.slice(contentIndent);
          if (lead >= contentIndent || lineBlank) {
            itemText += '\n' + sliced;
          } else {
            if (blankLine || prevLead >= 4 ||
                prevLineBreaksItem(prevContent, fenceRx, headingRx, htmlRx, hrRx)) break;
            const fc = firstNonSpaceChar(line);
            const setextLine = (fc === 61 || fc === 45) && /^ {0,3}(?:=+|-+) *$/.test(line) &&
              BG.setext.test(`${prevContent}\n${line}`)
              ? `    ${expanded.replace(/^ {0,3}/, '')}`
              : line;
            itemText += '\n' + setextLine;
          }
          blankLine = lineBlank;
          src = nl === -1 ? '' : src.slice(nl + 1);
          prevContent = sliced;
          prevLead = leadingWidth(sliced);
        }
      }
      const itemRaw = fullSrc.slice(itemStart, consumed());
      if (!list.loose) {
        if (sawDoubleBlank) list.loose = true;
        else if (endsWithDoubleBlank(itemRaw)) sawDoubleBlank = true;
      }
      list.items.push({
        type: 'list_item', raw: itemRaw,
        task: RX.listIsTask.test(itemText),
        loose: false, text: itemText, tokens: [],
      });
    }
    const lastItem = list.items[list.items.length - 1];
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else return undefined;
    list.raw = fullSrc.slice(0, consumed()).trimEnd();
    for (const item of list.items) {
      this.st.top = false;
      item.tokens = this.tokenizeBlocks(item.text, []);
      if (!list.loose) {
        for (const t of item.tokens) {
          if (t.type === 'space' && RX.anyLine.test(t.raw)) { list.loose = true; break; }
        }
      }
    }
    for (const item of list.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(RX.listStripTask, '');
        first.raw = first.raw.replace(RX.listStripTask, '');
        first.text = first.text.replace(RX.listStripTask, '');
        for (let g = this.queue.length - 1; g >= 0; g--) {
          if (RX.listIsTask.test(this.queue[g].src)) {
            this.queue[g].src = this.queue[g].src.replace(RX.listStripTask, '');
            break;
          }
        }
        const cb = RX.taskBox.exec(item.raw);
        if (cb) {
          const checkbox = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
          item.checked = checkbox.checked;
          if (list.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type)) {
              item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
              item.tokens[0].text = checkbox.raw + item.tokens[0].text;
              // The paragraph's HTML is rendered later from its queued
              // source (already stripped of the task marker), so the
              // checkbox HTML is kept as a prefix to prepend at render.
              item.tokens[0].htmlPrefix = checkHtml(checkbox);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, html: checkHtml(checkbox) });
            }
          } else {
            item.tokens.unshift(checkbox);
          }
        }
      } else if (item.task) item.task = false;
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return list;
  }
}
function codeHtml(tok) {
  const lang = (tok.lang || '').match(RX.notSpaceStart)?.[0] || '';
  const body = tok.text ? tok.text.replace(RX.endingNewline, '') + '\n' : '';
  const inner = escapeHtml(body, true);
  if (!lang) return `<pre><code>${inner}</code></pre>\n`;
  return `<pre><code class="language-${escapeHtml(lang)}">${inner}</code></pre>\n`;
}

function cellHtml(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return `${open}${cell.html}</${tag}>\n`;
}

function tableHtml(tok) {
  let head = '';
  for (const cell of tok.header) head += cellHtml(cell);
  const thead = `<tr>\n${head}</tr>\n`;
  let body = '';
  for (const row of tok.rows) {
    let cells = '';
    for (const cell of row) cells += cellHtml(cell);
    body += `<tr>\n${cells}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return `<table>\n<thead>\n${thead}</thead>\n${body}</table>\n`;
}

function listHtml(tok) {
  const tag = tok.ordered ? 'ol' : 'ul';
  const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
  let items = '';
  for (const item of tok.items) items += `<li>${blocksHtml(item.tokens)}</li>\n`;
  return `<${tag}${start}>\n${items}</${tag}>\n`;
}

function checkHtml(tok) {
  const checked = tok.checked ? 'checked="" ' : '';
  return '<input ' + checked + 'disabled="" type="checkbox"> ';
}

function blocksHtml(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${tok.depth}>${tok.htmlPrefix || ''}${tok.html === undefined ? escapeHtml(tok.text) : tok.html}</h${tok.depth}>\n`; break;
      case 'code': out += codeHtml(tok); break;
      case 'table': out += tableHtml(tok); break;
      case 'blockquote': out += `<blockquote>\n${blocksHtml(tok.tokens)}</blockquote>\n`; break;
      case 'list': out += listHtml(tok); break;
      case 'checkbox': out += checkHtml(tok); break;
      case 'html': out += tok.text; break;
      case 'def': break;
      case 'paragraph': out += `<p>${tok.htmlPrefix || ''}${tok.html === undefined ? escapeHtml(tok.text) : tok.html}</p>\n`; break;
      case 'text':
        out += tok.html === undefined ? escapeHtml(tok.text) : `${tok.htmlPrefix || ''}${tok.html}`;
        break;
      default: throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* entry point                                                         */
/* ------------------------------------------------------------------ */

// Render `markdown` to the HTML marked 18.1.3 produces with its
// defaults. Stateless: every call builds a fresh parser and keeps
// nothing between calls.
export function parse(markdown) {
  const doc = new Parser();
  const tokens = doc.run(markdown);
  return blocksHtml(tokens);
}
