// parse.js — a Markdown to HTML renderer written from scratch, behaviourally
// matching marked 18.1.3 with its default options (gfm on, breaks off, pedantic
// off, async off). No dependencies, no I/O, no caching between calls: every
// parse(markdown) call is computed purely from its input string.
//
// Design: two passes over the text, like any CommonMark renderer — first split
// the document into blocks (headings, lists, quotes, fences, tables, ...),
// then render the inline spans (emphasis, links, code spans, ...) inside each
// block's text, emitting HTML directly from the token lists. The block and
// inline grammars below are my own transcription of the CommonMark 0.31.2 /
// GFM 0.29 rules as marked applies them, verified against marked's output.

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape HTML special characters. When `encode` is true every & < > " ' is
// escaped; when false, an & that already starts a valid character reference
// or named entity is left alone (so `&copy;` survives, `&x` becomes `&amp;x`).
const RE_ESC = /[&<>"']/g;
const RE_ESC_NO_ENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RE_ESC_TEST = /[&<>"']/;
const RE_ESC_NO_ENC_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
function esc(s, encode) {
  if (encode) {
    return RE_ESC_TEST.test(s) ? s.replace(RE_ESC, (ch) => ESC_MAP[ch]) : s;
  }
  // Fast path: the plain char-class test is far cheaper than the
  // lookahead-bearing NO_ENC test. Without '&' the two replaces agree
  // (the '&' alternative never fires), so only &-bearing strings need
  // the full test.
  if (!RE_ESC_TEST.test(s)) return s;
  if (!s.includes('&')) return s.replace(RE_ESC, (ch) => ESC_MAP[ch]);
  return RE_ESC_NO_ENC_TEST.test(s) ? s.replace(RE_ESC_NO_ENC, (ch) => ESC_MAP[ch] || '&amp;') : s;
}

// Decode numeric character references in inline text. `&#38;` becomes `&amp;`
// (so it is not re-decoded), out-of-range / surrogate / zero code points
// become U+FFFD, and a bare & that is not part of a valid reference is
// written as `&amp;`. Named entities are NOT decoded here — they pass
// through untouched and the browser resolves them.
const RE_NUMREF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const RE_NUMREF_OR_BARE_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function unescape(s) {
  if (!s.includes('&#')) return s;
  if (!RE_NUMREF.test(s)) return s;
  return s.replace(RE_NUMREF_OR_BARE_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// Sanitise a link/image href the way marked does: encodeURI, then un-escape
// the %25 it produced (so a literal % in the source stays a literal %).
// Returns null when encodeURI throws (lone surrogates in the href).
const RE_CLEAN_URL_SAFE = /^[A-Za-z0-9;,\/?:@&=+$_.!~*'()#%-]*$/;
function cleanUrl(href) {
  // encodeURI leaves exactly these characters (plus '%' whose %25 the
  // replace below undoes) untouched, so such hrefs need no work at all.
  if (RE_CLEAN_URL_SAFE.test(href)) return href;
  try {
    const u = encodeURI(href);
    return u.includes('%25') ? u.replace(/%25/g, '%') : u;
  } catch {
    return null;
  }
}

// Split one table row on unescaped pipes, trimming cells and dropping the
// empty cells produced by leading / trailing pipes. Pads or truncates to
// `count` cells when given.
function splitCells(row, count) {
  // Without a backslash no pipe is escaped: splitting on '|' directly
  // gives the same cells as the replace-then-split below (which only
  // inserts a space before each unescaped pipe), and no cell needs its
  // escaped pipes restored.
  const hasBS = row.includes('\\');
  const cells = hasBS
    ? row.replace(/\|/g, (ch, off, str) => {
        let backslashes = false;
        for (let p = off - 1; p >= 0 && str[p] === '\\'; p--) backslashes = !backslashes;
        return backslashes ? '|' : ' |';
      }).split(' |')
    : row.split('|');
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) {
    cells[i] = cells[i].trim();
    if (hasBS) cells[i] = cells[i].replace(/\\\|/g, '|');
  }
  return cells;
}

// Trim trailing characters: remove a run of `ch` from the end of `s`
// (or, with invert, a run of characters that are NOT `ch`).
function rtrim(s, ch, invert) {
  const n = s.length;
  if (n === 0) return '';
  let k = 0;
  for (; k < n;) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !invert) k++;
    else if (c !== ch && invert) k++;
    else break;
  }
  return s.slice(0, n - k);
}

// Drop trailing blank lines, but keep the text unchanged when there are at
// most one of them (a single trailing blank line is part of the raw text).
function stripTrailingBlanks(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && /^[ \t]*$/.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Expand tabs to spaces, tracking the visual column (tab stops every 4).
function expandTabs(s, col) {
  let out = '';
  let c = col || 0;
  for (const ch of s) {
    if (ch === '\t') {
      const w = 4 - (c % 4);
      out += ' '.repeat(w);
      c += w;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// Normalise a link reference label: trim, collapse internal whitespace to
// single spaces, then case-fold (lower, upper, lower — the Unicode-aware
// fold marked uses, which also handles characters like İ and ß).
const RE_NON_ASCII = /[^\x00-\x7F]/;
function normLabel(s) {
  s = s.trim().replace(/\s+/g, ' ');
  // ASCII labels fold with a single toLowerCase; the triple conversion
  // is only needed for non-ASCII case folding.
  if (!RE_NON_ASCII.test(s)) return s.toLowerCase();
  return s.toLowerCase().toUpperCase().toLowerCase();
}

// Scan `s` tracking the balance of the pair `open`/`close`, skipping
// backslash-escaped characters. Returns -1 when balanced (or the pair never
// appears), -2 when an opener is left unmatched, or the index of the first
// unmatched closer.
function parenBalance(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1] && (--depth, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Does the link label `label` (starting at offset `at` in the source `src`)
// contain a `<` that opens a raw HTML tag or autolink which is not closed
// inside the label? If so the link is not a link at all.
function labelHasOpenTag(src, label, at, rx) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const m = rx.code.exec(label.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(at + i);
    const m = rx.tag.exec(rest) || rx.autolink.exec(rest);
    if (m) {
      if (m[0].length > label.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* shared patterns                                                     */
/* ------------------------------------------------------------------ */

// Block-level HTML tag names that can interrupt a paragraph / start an
// HTML block (CommonMark's type-6 list).
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
// Tags that can never start an HTML block in a paragraph's way (they are
// treated as inline HTML instead).
const INLINE_ONLY_TAGS = 'a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img';

const RE = {
  // generic
  crlf: /\r\n|\r/g,
  blankLine: /^[ \t]*$/,
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  fenceIndent: /^(\s+)(?:```)/,
  leadingSpaces: /^\s+/,
  endingHash: /#$/,
  startsSpace: /^ /,
  endsSpace: / $/,
  endsSpaceTab: /[ \t]$/,
  nonSpace: /[^ ]/,
  newlineGlobal: /\n/g,
  tabGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multiSpace: /\s+/g,
  doubleBlank: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetext: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteMarkerWs: /^( {0,3}>)([ \t]+)/gm,
  blockquoteSetext2: /^ {0,3}>[ \t]?/gm,
  listNest: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  taskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tablePipe: /[:|]/,
  tableEdge: /^\||\| *$/g,
  tableRowBlank: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngle: /^</,
  endAngle: />$/,
  pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/,
  unicodeAlnum: /[\p{L}\p{N}]/u,
  percent25: /%25/g,
  spaceOnlyLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  // a backslash followed by an ASCII punctuation character
  backslashPunct: /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  // punctuation classes used by the emphasis scanner
  punct: /[\p{P}\p{S}]/u,
  punctNoTilde: /(?!~)[\p{P}\p{S}]/u,
  punctOrSpace: /[\s\p{P}\p{S}]/u,
  punctOrSpaceNoTilde: /(?!~)[\s\p{P}\p{S}]/u,
  notPunctOrSpace: /[^\s\p{P}\p{S}]/u,
  notPunctOrSpaceTilde: /(?:[^\s\p{P}\p{S}]|~)/u,
  openQuote: /[\p{Pi}\p{Ps}"']/u,
  // "not * or _ followed by punct/space" — used for the left-delimiter test
  ldelimPunct: /^((?![*_])[\s\p{P}\p{S}])/u,
};

/* ------------------------------------------------------------------ */
/* block grammar                                                       */
/* ------------------------------------------------------------------ */

// Building the block regexes from templates keeps the paragraph / setext
// heading / table patterns consistent: each placeholder names the block
// construct that may interrupt the current one.

const BULLET = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const HR_SRC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const BLOCKQUOTE_SRC = ' {0,3}>';
const FENCES_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const HTML_OPEN_SRC = ' {0,3}(?:</?(?:' + BLOCK_TAGS + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';

function buildParagraph(listSrc, tableSrc) {
  const tpl = '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
  // the table pattern is substituted before the HTML one: the HTML
  // pattern's tag list itself contains the word "table"
  const tablePat = tableSrc ? tableSrc.replace(/(^|[^\[])\^/g, '$1') : '';
  let src = tpl
    .replace('hr', HR_SRC)
    .replace('heading', HEADING_SRC)
    .replace('|lheading', '');
  src = tablePat ? src.replace('table', tablePat) : src.replace('|table', '');
  src = src
    .replace('blockquote', BLOCKQUOTE_SRC)
    .replace('fences', FENCES_SRC)
    .replace('list', listSrc)
    .replace('html', HTML_OPEN_SRC);
  return new RegExp(src);
}

// Setext heading: text lines, then a line of = or -.
function buildSetext(tableSrc) {
  const tpl = '^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
  return new RegExp(
    tpl
      .replace(/bull/g, BULLET)
      .replace('blockCode', '(?: {4}| {0,3}\\t)')
      .replace(/fences/g, ' {0,3}(?:`{3,}|~{3,})')
      .replace(/blockquote/g, BLOCKQUOTE_SRC)
      .replace(/heading/g, HEADING_SRC)
      .replace('hr', HR_SRC)
      .replace(/html/g, ' {0,3}<[^\\n>]+>\\n')
      .replace(/table/g, tableSrc)
  );
}

const TABLE_SRC = ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n';
const TABLE_ROW_STOP = ' {0,3}(?:[*+-]|1[.)])[ \\t]';

function buildTable() {
  const tpl = '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)';
  return new RegExp(
    tpl
      .replace('hr', HR_SRC)
      .replace('heading', HEADING_SRC)
      .replace('blockquote', BLOCKQUOTE_SRC)
      .replace('code', '(?: {4}| {0,3}\\t)[^\\n]')
      .replace('fences', FENCES_SRC)
      .replace('list', TABLE_ROW_STOP)
      .replace('html', HTML_OPEN_SRC)
  );
}

// HTML block, type 1-7 (GFM): script/pre/style/textarea, comment, processing
// instruction, declaration, CDATA, block tag open/close, or a lone tag line.
const HTML_COMMENT = '<!--(?:-?>|[\\s\\S]*?(?:-->|$))';
const HTML_ATTR = ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?';
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
  BLOCK_HTML_SRC.replace('comment', HTML_COMMENT).replace(/tag/g, BLOCK_TAGS).replace(/attribute/g, HTML_ATTR),
  'i'
);

const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  indentedCode: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: new RegExp('^' + HR_SRC),
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  listStart: new RegExp('^(' + BULLET + ')([ \\t][^\\n]*?)?(?:\\n|$)'),
  html: BLOCK_HTML,
  defLabel: /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/,
  defTitle: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\)/,
  table: buildTable(),
  setext: buildSetext(TABLE_SRC),
  paragraph: buildParagraph(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]', buildTable().source),
  text: /^[^\n]+/,
};
BLOCK.def = new RegExp(
  '^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)'
    .replace('label', BLOCK.defLabel.source)
    .replace('title', BLOCK.defTitle.source)
);
// the paragraph inside a blockquote may also be interrupted by any ordered
// list marker, so it gets its own variant
BLOCK.quoteParagraph = buildParagraph(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)', '');
BLOCK.blockquote = new RegExp(
  '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+'
    // the embedded paragraph loses its ^ anchor, like any substituted part
    .replace('paragraph', BLOCK.quoteParagraph.source.replace(/(^|[^\[])\^/g, '$1'))
);

// indent-dependent helpers, cached per indent level (0..3 are the only ones
// that occur: a list item's content is indented at most 3 + marker width,
// but the regexes are parameterised by the content indent which can be
// larger — cache up to a small bound and build beyond it)
// Indent-dependent break tests for list items. The indent used in the
// pattern is the content indent minus one, clamped to 0..3: a construct
// indented exactly to the item's content level belongs to the item, it
// does not interrupt it.
const indentCache = new Map();
function indentRegex(kind, n) {
  const k = Math.max(0, Math.min(3, n - 1));
  const key = kind + ':' + k;
  let rx = indentCache.get(key);
  if (rx) return rx;
  if (kind === 'bullet') rx = new RegExp(`^ {0,${k}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`);
  else if (kind === 'hr') rx = new RegExp(`^ {0,${k}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`);
  else if (kind === 'fences') rx = new RegExp(`^ {0,${k}}(?:\`\`\`|~~~)`);
  else if (kind === 'heading') rx = new RegExp(`^ {0,${k}}#{1,6}(?:\\s|$)`);
  else if (kind === 'html') rx = new RegExp(`^ {0,${k}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
  else rx = new RegExp(`^ {0,${k}}>`);
  indentCache.set(key, rx);
  return rx;
}
const listItemCache = new Map();
function listItemRegex(markerSrc) {
  let rx = listItemCache.get(markerSrc);
  if (!rx) {
    rx = new RegExp(`^( {0,3}${markerSrc})((?:[ \\t][^\\n]*)?(?:\\n|$))`);
    listItemCache.set(markerSrc, rx);
  }
  return rx;
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
// The longer label form used when scanning for reference links inside text
// that emphasis may not cross.
const LABEL_LONG = '(?:[^\\[\\]\\\\`]*(?:\\[(?:brackets|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';

function sub(src, placeholder, replacement) {
  // like marked's regex builder: a substituted pattern loses its ^ anchor
  // (so it can match mid-string) and the placeholder is replaced once
  // (or globally when a regex is passed)
  const rep = typeof replacement === 'string' ? replacement : replacement.source;
  return src.replace(placeholder, rep.replace(/(^|[^\[])\^/g, '$1'));
}

const LINK_LABEL = LABEL_INNER.replace(/brackets/g, BRACKET_PAIR);
const LINK_HREF = '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))';
const LINK_TITLE = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  // inline HTML: comment, closing tag, opening tag, processing instruction,
  // declaration, CDATA
  tag: new RegExp(
    '^<!--(?:-?>|[\\s\\S]*?-->)|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>'
      .replace(/attribute/g, '\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?')
  ),
  // <scheme:...> or <email>
  autolink: new RegExp(
    '^<(' + '[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*' + '|' + "[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])" + ')>'
  ),
  // extended autolinks: mailto:/xmpp: addresses, scheme:// URLs, www., email
  url: new RegExp(
    '^(?:(?:mailto:[a-zA-Z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])|xmpp:[a-zA-Z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])(?:\\/[A-Za-z0-9@.]+)?)|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^[a-zA-Z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-]))'
  ),
  urlBackpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  // inline link: ![label](href "title") — the label/href/title parts are
  // substituted in below
  link: null,
  reflink: null,
  nolink: null,
  reflinkSearch: null,
  // constructs the emphasis mask must not look inside: links, code spans,
  // and raw HTML tags (each replaced by a same-length bracketed filler)
  blockSkip: null,
  // punctuation outside code spans (escaped punctuation becomes '+'s)
  anyPunctOutsideCode: null,
  // emphasis left delimiter: a run of * or _ plus the character after it.
  // group 1/2 = after a * run (punct / other), group 3/4 = after a _ run.
  // The (?!~) keeps ~ out of the punctuation class: ~ is the strikethrough
  // delimiter, not emphasis punctuation.
  emStrongL: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  delL: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  // "the character before the delimiter is punctuation or whitespace
  // (but not * or _)" — a single-character test
  punctBefore: /^((?![*_])[\s\p{P}\p{S}])/u,
  anyPunct: /\\([\p{P}\p{S}])/gu,
};

// link / reflink / nolink, built from the label pieces above
INLINE.link = new RegExp(
  sub(sub(sub('^!?\\[(label)\\]\\([ \\t\\n]*(href)(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(title))?[ \\t\\n]*\\)', 'label', LINK_LABEL), 'href', LINK_HREF), 'title', LINK_TITLE)
);
INLINE.reflink = new RegExp(
  sub(sub('^!?\\[(label)\\]\\[(ref)\\]', 'label', LINK_LABEL), 'ref', REF_LABEL)
);
INLINE.nolink = new RegExp(sub('^!?\\[(ref)\\](?:\\[\\])?', 'ref', REF_LABEL));
// the global scanner for reference-style links, used by the emphasis mask
// and by linkInText; its ^ anchors are stripped so it matches mid-string
INLINE.reflinkSearch = new RegExp(
  sub(
    sub('reflink|nolink(?!\\()', 'reflink',
      sub(sub('^!?\\[(label)\\]\\[(ref)\\]', 'label', LABEL_LONG.replace(/brackets/g, BRACKET_PAIR)), 'ref', REF_LABEL_SEARCH)),
    'nolink',
    sub('^!?\\[(ref)\\](?:\\[\\])?', 'ref', REF_LABEL_SEARCH)
  ),
  'g'
);
INLINE.blockSkip = new RegExp(
  sub(
    sub(
      sub(
        sub('link|precode-code|html', 'link',
          '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)'),
        'precode-', '(?<!`)()'),
      'code', '(?<b>`+)[^`]+\\k<b>(?!`)'),
    'html', '<(?! )[^<>]*?>'),
  'g'
);
INLINE.anyPunctOutsideCode = new RegExp(
  '(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\([\\p{P}\\p{S}])', 'gu'
);
// (plain text is scanned by textEnd() below, not by a regex)

// Right-delimiter scanners for emphasis / strikethrough. Each alternative
// matches some skipped text plus a delimiter run; which group holds the run
// tells the scanner the run's flanking:
//   g1 run after punctuation, followed by space/end
//   g2 run after non-punct non-space, followed by punct/space/end
//   g3 run after punct/space, followed by non-punct non-space (open only)
//   g4 run after a space, followed by punctuation (open only)
//   g5 run after punctuation, followed by punctuation (open and close)
//   g6 run after non-punct non-space, followed by non-punct non-space (both)
// The templates use placeholder class names, substituted below: for
// emphasis the classes are tilde-aware (~ is not punctuation there), for
// strikethrough they are the plain Unicode classes.
function buildRDelim(template, punct, punctSpace, notPunctSpace) {
  return new RegExp(
    template
      .replace(/notPunctSpace/g, notPunctSpace)
      .replace(/punctSpace/g, punctSpace)
      .replace(/punct/g, punct),
    'gu'
  );
}
const AST_RDELIM_TPL =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])' +
  '|(?!\\*)punct(\\*+)(?=[\\s]|$)' +
  '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' +
  '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' +
  '|[\\s](\\*+)(?!\\*)(?=punct)' +
  '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' +
  '|notPunctSpace(\\*+)(?=notPunctSpace)';
// The `_` closer scanner is the plain one: it has no "both" alternative
// for a run between two word characters (so `_foo_bar` stays literal),
// and its punctuation class is the plain Unicode one. (The tilde-aware
// variant with the extra alternative is only the pedantic one.)
const UND_RDELIM_TPL =
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])' +
  '|(?!_)punct(_+)(?=[\\s]|$)' +
  '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' +
  '|(?!_)punctSpace(_+)(?=notPunctSpace)' +
  '|[\\s](_+)(?!_)(?=punct)' +
  '|(?!_)punct(_+)(?!_)(?=punct)';
const DEL_RDELIM_TPL =
  '^[^~]+(?=[^~])' +
  '|(?!~)punct(~~?)(?=[\\s]|$)' +
  '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' +
  '|(?!~)punctSpace(~~?)(?=notPunctSpace)' +
  '|[\\s](~~?)(?!~)(?=punct)' +
  '|(?!~)punct(~~?)(?!~)(?=punct)' +
  '|notPunctSpace(~~?)(?=notPunctSpace)';
INLINE.emStrongRAst = buildRDelim(AST_RDELIM_TPL, '(?!~)[\\p{P}\\p{S}]', '(?!~)[\\s\\p{P}\\p{S}]', '(?:[^\\s\\p{P}\\p{S}]|~)');
INLINE.emStrongRUnd = buildRDelim(UND_RDELIM_TPL, '[\\p{P}\\p{S}]', '[\\s\\p{P}\\p{S}]', '[^\\s\\p{P}\\p{S}]');
INLINE.delR = buildRDelim(DEL_RDELIM_TPL, '[\\p{P}\\p{S}]', '[\\s\\p{P}\\p{S}]', '[^\\s\\p{P}\\p{S}]');

/* ------------------------------------------------------------------ */
/* emphasis masking                                                    */
/* ------------------------------------------------------------------ */

// Scan a (masked) inline source for the last delimiter run that could
// close emphasis / strikethrough: the run's first character must not be
// preceded by whitespace. The index recorded is the run's first character.
// This is only an upper bound for the closer search — the real flanking
// rules are checked by the delimiter scanners. Walking back from the last
// occurrence of each delimiter (native lastIndexOf) is far cheaper than
// scanning every character of a long paragraph.
// Shared empty emphasis-closer map (never mutated) for sources without
// an emphasis delimiter.
const NO_CLOSERS_EM = { '*': -1, _: -1 };

function scanClosers(src) {
  const em = { '*': -1, _: -1 };
  let del = -1;
  for (let d = 0; d < 3; d++) {
    const r = d === 0 ? '*' : d === 1 ? '_' : '~';
    let end = src.lastIndexOf(r);
    while (end !== -1) {
      let s = end;
      while (s > 0 && src[s - 1] === r) s--;
      const prev = s === 0 ? 10 : src.charCodeAt(s - 1);
      if (prev !== 32 && prev !== 9 && prev !== 10 && prev !== 13 && prev !== 12) {
        if (r === '~') del = s;
        else em[r] = s;
        break;
      }
      // A run before this one must end at or before s - 2 (s - 1 holds the
      // whitespace before this run); with s < 2 there is no earlier run.
      // (lastIndexOf with a negative from-index searches from the END of
      // the string, so it must never be called with s - 2 < 0.)
      end = s >= 2 ? src.lastIndexOf(r, s - 2) : -1;
    }
  }
  return { maskedSrc: src, em, del };
}

// Build the masked copy of an inline source that the emphasis scanner
// works on: reference-link labels that resolve are hidden (their text can
// never be an emphasis closer), escaped punctuation becomes '+'s, and
// links / code spans / raw HTML are replaced by same-length bracketed
// fillers, so delimiters inside them are invisible to the scanner.
// Anything that can start an inline construct, change escaping, or stop
// plain text: backslash, angle brackets, brackets, backtick, emphasis /
// strikethrough delimiters, ampersand, quotes, autolink triggers, or a
// hard-break run of spaces before a newline. Text with none of these is
// one plain text token, byte for byte.
const RE_PLAIN_INLINE = /["'&<>\\[\]`*_~]|www\.|:\/\/|@|mailto:|xmpp:|  \n/;
// Any autolink / hard-break stop a plain-text token could contain
// (checked with includes() in inlineTokens, faster than the regex).

// Replace backticks inside code spans with '+' (so the blockSkip pass
// can match those spans), without a regex: for each opening backtick run
// find the first later run of the same length that can close it — the
// same span the anyPunctOutsideCode regex would match, since a closer
// must start right after a non-backtick character and be a maximal run.
// Returns the input unchanged (no allocation) when no code span contains
// an interior backtick.
function maskCodeSpanTicks(t) {
  const n = t.length;
  let pos = 0;
  let parts = null;
  for (;;) {
    const open = t.indexOf('`', pos);
    if (open === -1) break;
    let runEnd = open;
    while (runEnd < n && t.charCodeAt(runEnd) === 96) runEnd++;
    const runLen = runEnd - open;
    let close = -1;
    let p = runEnd;
    while (p < n) {
      const c = t.indexOf('`', p);
      if (c === -1) break;
      let e = c;
      while (e < n && t.charCodeAt(e) === 96) e++;
      if (e - c === runLen && c > runEnd) { close = c; break; }
      p = e;
    }
    if (close === -1) {
      if (parts !== null) parts.push(t.slice(pos, runEnd));
      pos = runEnd;
      continue;
    }
    const content = t.slice(runEnd, close);
    if (!content.includes('`')) {
      if (parts !== null) parts.push(t.slice(pos, close + runLen));
      pos = close + runLen;
      continue;
    }
    if (parts === null) parts = [t.slice(0, runEnd)];
    else parts.push(t.slice(pos, runEnd));
    parts.push(content.replace(/`/g, '+'), t.slice(close, close + runLen));
    pos = close + runLen;
  }
  if (parts === null) return t;
  parts.push(t.slice(pos));
  return parts.join('');
}

// Replace code spans and raw HTML tags with same-length bracketed
// fillers, without a regex — the same matches the blockSkip regex would
// find when no inline link `[...](...)` is present (so its link
// alternative cannot match). A code span is a maximal backtick run, a
// non-empty run of non-backtick characters, and a closing run of the
// same length; an HTML tag is '<' not followed by a space, then
// characters that are neither '<' nor '>', then '>'. Returns the input
// unchanged (no allocation) when nothing matches.
// Inline link starting at `t[start]` ('['): the label runs to the first
// ']' (a '[' outside a code span ends it, a code span's closer is the
// first backtick run after its opener and must have the opener's
// length), then '(' and a destination with one level of paren nesting
// and backslash escapes, then ')'. Returns the index just past the ')',
// or -1 when the text is not an inline link. This mirrors the link
// alternative of the blockSkip regex.
function linkEnd(t, start) {
  const n = t.length;
  let i = start + 1;
  while (i < n) {
    const c = t.charCodeAt(i);
    if (c === 93) break; // ']' ends the label
    if (c === 91) return -1; // '[' cannot appear in the label
    if (c === 96) { // backtick run: skip the code span it opens
      let e = i;
      while (e < n && t.charCodeAt(e) === 96) e++;
      const runLen = e - i;
      const c2 = t.indexOf('`', e);
      if (c2 === -1) return -1;
      let e2 = c2;
      while (e2 < n && t.charCodeAt(e2) === 96) e2++;
      if (e2 - c2 !== runLen) return -1;
      i = e2;
      continue;
    }
    i++;
  }
  if (i >= n || t.charCodeAt(i + 1) !== 40) return -1; // no ']' or no '('
  let depth = 0;
  let j = i + 2;
  while (j < n) {
    const c = t.charCodeAt(j);
    if (c === 92) { j += 2; continue; } // backslash escape
    if (c === 40) { // '('
      if (depth === 1) return -1; // cannot nest deeper: the link fails
      depth = 1;
      j++;
      continue;
    }
    if (c === 41) { // ')'
      if (depth === 1) { depth = 0; j++; continue; }
      return j + 1;
    }
    j++;
  }
  return -1;
}

// Replace links, code spans and raw HTML tags with same-length bracketed
// fillers, without a regex — the same matches the blockSkip regex would
// find. One left-to-right pass: at each step the next '[', backtick or
// '<' decides what is tried (a match can only start at one of those),
// and a construct that does not match is left literal. A link is only
// attempted when `withLinks` is set (a link needs '](' somewhere).
// Returns the input unchanged (no allocation) when nothing matches.
function maskAll(t, withLinks) {
  const n = t.length;
  let pos = 0;
  let parts = null;
  let htmlDead = false;
  for (;;) {
    const bt = t.indexOf('`', pos);
    const lt = htmlDead ? -1 : t.indexOf('<', pos);
    const br = withLinks ? t.indexOf('[', pos) : -1;
    let next = -1;
    let kind = 0; // 1 = backtick, 2 = '<', 3 = '['
    if (bt !== -1) { next = bt; kind = 1; }
    if (lt !== -1 && (next === -1 || lt < next)) { next = lt; kind = 2; }
    if (br !== -1 && (next === -1 || br < next)) { next = br; kind = 3; }
    if (next === -1) break;
    if (kind === 3) {
      const end = linkEnd(t, next);
      if (end === -1) {
        // Not a link: the '[' stays literal.
        if (parts !== null) parts.push(t.slice(pos, next + 1));
        pos = next + 1;
        continue;
      }
      if (parts === null) parts = [t.slice(0, next)];
      else parts.push(t.slice(pos, next));
      parts.push('[' + 'a'.repeat(end - next - 2) + ']');
      pos = end;
    } else if (kind === 1) {
      let runEnd = next;
      while (runEnd < n && t.charCodeAt(runEnd) === 96) runEnd++;
      const runLen = runEnd - next;
      // The closer is the first later run of the opener's length: a
      // code span's content may hold backtick runs of other lengths, so
      // the first run is not necessarily the closer. A code span cannot
      // start mid-run, so a miss advances past the run.
      let close = -1;
      let p = runEnd;
      while (p < n) {
        const c = t.indexOf('`', p);
        if (c === -1) break;
        let e = c;
        while (e < n && t.charCodeAt(e) === 96) e++;
        if (e - c === runLen) { close = c; break; }
        p = e;
      }
      if (close === -1) {
        if (parts !== null) parts.push(t.slice(pos, runEnd));
        pos = runEnd;
        continue;
      }
      if (parts === null) parts = [t.slice(0, next)];
      else parts.push(t.slice(pos, next));
      parts.push('[' + 'a'.repeat(close + runLen - next - 2) + ']');
      pos = close + runLen;
    } else {
      // HTML tag
      if (t.charCodeAt(next + 1) === 32) {
        if (parts !== null) parts.push(t.slice(pos, next + 1));
        pos = next + 1;
        continue;
      }
      const gt = t.indexOf('>', next + 1);
      if (gt === -1) { htmlDead = true; continue; }
      const lt2 = t.indexOf('<', next + 1);
      if (lt2 !== -1 && lt2 < gt) {
        if (parts !== null) parts.push(t.slice(pos, next + 1));
        pos = next + 1;
        continue;
      }
      if (parts === null) parts = [t.slice(0, next)];
      else parts.push(t.slice(pos, next));
      parts.push('[' + 'a'.repeat(gt - next - 1) + ']');
      pos = gt + 1;
    }
  }
  if (parts === null) return t;
  parts.push(t.slice(pos));
  return parts.join('');
}

// Cheap necessary condition for a reference-style link anywhere in
// `src`: a full `[label][ref]` contains '][', and a shortcut `[label]`
// (or `[label][]`) has a ']' not followed by '('. When neither holds,
// the reference-link search regex cannot match, so it is skipped.
function hasRefLinkCandidate(src) {
  if (src.includes('][')) return true;
  let p = src.indexOf(']');
  while (p !== -1) {
    if (src.charCodeAt(p + 1) !== 40) return true;
    p = src.indexOf(']', p + 1);
  }
  return false;
}

function maskInline(src, lexer) {
  let t = src;
  if (lexer.hasLinks && src.includes('[') && src.includes(']') && hasRefLinkCandidate(src)) {
    const rx = INLINE.reflinkSearch;
    const hideRef = (m) => {
      const o = m.lastIndexOf('[');
      if (!Object.hasOwn(lexer.links, lexer.normLabel(m.slice(o + 1, -1)))) return m;
      if (o > 1 && m.charAt(0) !== '!') {
        const inner = m.slice(1, o - 1);
        if (linkInText(inner, lexer)) {
          return '[' + inner.replace(rx, hideRef) + '][' + 'a'.repeat(m.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m.length - 2) + ']';
    };
    t = t.replace(rx, hideRef);
  }
  // escaped punctuation only exists when there is a backslash; without
  // one only code spans with interior backticks need masking — and only
  // when an inline link is present, because the hand scanner below
  // matches such spans directly while the blockSkip regex cannot
  if (src.includes('\\')) {
    t = t.replace(INLINE.anyPunctOutsideCode, (m, ticks, punct) =>
      punct ? '+'.repeat(m.length)
        : ticks ? ticks + m.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks
        : m);
  } else if (src.includes('`') && t.includes('](')) {
    t = maskCodeSpanTicks(t);
  }
  // links, code spans and raw HTML only exist when one of ](, `, < appears.
  // With no inline link the blockSkip regex's link alternative cannot
  // match, so the hand scanner above does the same job without a regex.
  if (src.includes('](') || src.includes('`') || src.includes('<')) {
    t = maskAll(t, t.includes(']('));
  }
  return t;
}

// Does `src` contain a link (inline or reference) anywhere inside it?
// Used by the mask to decide whether a reference label's inner text must
// be masked recursively.
function linkInText(src, lexer) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(INLINE.blockSkip)) {
    if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(INLINE.reflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(lexer.links, lexer.normLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(s.slice(1, r - 1), lexer))) return true;
  }
  return false;
}

function closerIndex(lexer, masked, delim) {
  const top = lexer.maskStack[lexer.maskStack.length - 1];
  if (top && top.maskedSrc === masked) return top.em[delim];
  return scanClosers(masked).em[delim];
}
function delCloserIndex(lexer, masked) {
  const top = lexer.maskStack[lexer.maskStack.length - 1];
  if (top && top.maskedSrc === masked) return top.del;
  return scanClosers(masked).del;
}

/* ------------------------------------------------------------------ */
/* inline tokenizers                                                   */
/* ------------------------------------------------------------------ */

function makeLink(lexer, m, ref, raw) {
  const labelText = m[1].includes('\\') ? m[1].replace(/\\([\[\]])/g, '$1') : m[1];
  const isImage = m[0].charAt(0) === '!';
  const prevInLink = lexer.state.inLink;
  const prevEmitted = lexer.state.linkEmitted;
  const prevRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const innerTokens = lexer.inlineTokens(labelText);
  const nestedLink = lexer.state.linkEmitted;
  lexer.state.linkEmitted = prevEmitted;
  lexer.state.inLink = prevInLink;
  if (!isImage) {
    // links may not nest: if the label itself produced a link, this whole
    // construct is plain text instead
    if (nestedLink) {
      lexer.state.inRawBlock = prevRawBlock;
      return undefined;
    }
    lexer.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href: ref.href, title: ref.title || null, text: labelText, tokens: innerTokens };
}

function linkTok(lexer, src) {
  if (lexer.state.linkParenPossible === false) return undefined;
  // An inline link's label must be followed by '(': without '](' ahead
  // the big label regex cannot match.
  if (!src.includes('](')) return undefined;
  const m = INLINE.link.exec(src);
  if (!m) return undefined;
  const labelAt = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasOpenTag(src, m[1], labelAt, INLINE)) return undefined;
  const hrefPart = m[2].trim();
  if (RE.startAngle.test(hrefPart)) {
    if (!RE.endAngle.test(hrefPart)) return undefined;
    const stripped = rtrim(hrefPart.slice(0, -1), '\\');
    if ((hrefPart.length - stripped.length) % 2 === 0) return undefined;
  } else {
    const bal = parenBalance(m[2], '()');
    if (bal === -2) return undefined;
    if (bal > -1) {
      const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + bal;
      m[2] = m[2].substring(0, bal);
      m[0] = m[0].substring(0, cut).trim();
      m[3] = '';
    }
  }
  const noTrail = rtrim(m[0].slice(0, -1), '\\');
  if ((m[0].length - noTrail.length) % 2 === 0) return undefined;
  let href = m[2];
  const title = m[3] ? m[3].slice(1, -1) : '';
  href = href.trim();
  if (RE.startAngle.test(href)) href = href.slice(1, -1);
  return makeLink(lexer, m, {
    href: href && (href.includes('\\') ? href.replace(INLINE.anyPunct, '$1') : href),
    title: title && (title.includes('\\') ? title.replace(INLINE.anyPunct, '$1') : title),
  }, m[0]);
}

function reflinkTok(lexer, src) {
  const m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
  if (!m) return undefined;
  const labelAt = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasOpenTag(src, m[1], labelAt, INLINE)) return undefined;
  const ref = lexer.links[lexer.normLabel(m[2] || m[1])];
  if (!ref) {
    // an unresolved reference is just its first character as text
    const first = m[0].charAt(0);
    return { type: 'text', raw: first, text: first };
  }
  return makeLink(lexer, m, ref, m[0]);
}

function emStrongTok(lexer, src, masked, prev) {
  const m = INLINE.emStrongL.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return undefined;
  const delim = m[0][0];
  const sameAsPrev = prev === delim;
  const offset = masked.length - src.length;
  let l = offset;
  for (; l > 0 && masked[l - 1] === delim;) l--;
  const beforeRun = l > 0 ? lastCodePointBefore(masked, l) : '';
  const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || isLDelimPunct(beforeRun);
  if (l < offset) prev = beforeRun;
  const prevIsPunct = l < offset ? beforeIsPunct : isLDelimPunct(prev);
  // `_` cannot open emphasis when the character before the run is
  // alphanumeric and there is a character after the run
  if (m[4] && isPrevAlnum(prev)) return undefined;
  const afterPunct = m[1] || m[3] || '';
  if (!afterPunct || !prev || prevIsPunct) {
    // k = the run's length in code points, minus one when no character
    // follows the run (the run is ASCII, so its UTF-16 length is its
    // code-point length; a following character adds exactly one).
    let runCount = 0;
    while (runCount < m[0].length && m[0][runCount] === delim) runCount++;
    const k = runCount - 1 + (m[0].length > runCount ? 1 : 0);
    let openLeft = k;
    let skipped = 0;
    const y = offset - l + k;
    const canClose = !!beforeRun.trim() && (!!afterPunct || (delim === '*' && !beforeIsPunct));
    if (delim !== '*' && delim !== '_') return undefined;
    const scanRx = delim === '*' ? INLINE.emStrongRAst : INLINE.emStrongRUnd;
    const lastCloser = closerIndex(lexer, masked, delim);
    const scanStart = offset + k;
    if (lastCloser < scanStart) return undefined;
    const scanSrc = masked.slice(scanStart);
    const maxIndex = lastCloser - scanStart;
    let m2;
    for (scanRx.lastIndex = 0; (m2 = scanRx.exec(scanSrc)) !== null && !(m2.index > maxIndex);) {
      const g = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
      if (!g) continue;
      const b = g.length;
      if (m2[3] || m2[4]) {
        // open-only delimiter: it adds to the openers still to be closed
        openLeft += b;
        continue;
      } else if (m2[5] || m2[6] || canClose) {
        if (sameAsPrev && (m2[5] || m2[6])) break;
        // the rule of three: a closer whose length plus the opener's
        // length is a multiple of 3 (when the opener's isn't) cannot close
        if (y % 3 && !((y + b) % 3)) {
          skipped += b;
          continue;
        }
      }
      if (openLeft -= b, openLeft > 0) continue;
      const use = Math.min(b, b + openLeft + skipped);
      const firstLen = firstCharLen(m2[0]);
      const raw = src.slice(0, k + m2.index + firstLen + use);
      if (Math.min(k, use) % 2) {
        const inner = raw.slice(1, -1);
        return { type: 'em', raw, text: inner, tokens: lexer.inlineTokens(inner) };
      }
      const inner = raw.slice(2, -2);
      return { type: 'strong', raw, text: inner, tokens: lexer.inlineTokens(inner) };
    }
  }
  return undefined;
}

function delTok(lexer, src, masked, prev) {
  const m = INLINE.delL.exec(src);
  if (!m) return undefined;
  if (!(m[1] || '') || !prev || isLDelimPunct(prev)) {
    // runLen = the run's length in code points, minus one when no
    // character follows the run (the run is ASCII, so its UTF-16 length
    // is its code-point length; a following character adds exactly one).
    let runCount = 0;
    while (runCount < m[0].length && m[0][runCount] === '~') runCount++;
    const runLen = runCount - 1 + (m[0].length > runCount ? 1 : 0);
    let openLeft = runLen;
    const scanRx = INLINE.delR;
    const lastCloser = delCloserIndex(lexer, masked);
    const scanStart = masked.length - src.length + runLen;
    if (lastCloser < scanStart) return undefined;
    const scanSrc = masked.slice(scanStart);
    const maxIndex = lastCloser - scanStart;
    let m2;
    for (scanRx.lastIndex = 0; (m2 = scanRx.exec(scanSrc)) !== null && !(m2.index > maxIndex);) {
      const g = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
      if (!g) continue;
      let l = g.length;
      if (l !== runLen) continue;
      if (m2[3] || m2[4]) {
        openLeft += l;
        continue;
      }
      if (openLeft -= l, openLeft > 0) continue;
      l = Math.min(l, l + openLeft);
      const firstLen = firstCharLen(m2[0]);
      const raw = src.slice(0, runLen + m2.index + firstLen + l);
      const inner = raw.slice(runLen, -runLen);
      return { type: 'del', raw, text: inner, tokens: lexer.inlineTokens(inner) };
    }
  }
  return undefined;
}

function codespanTok(src) {
  if (src.indexOf('`', 1) === -1) return undefined;
  const m = INLINE.code.exec(src);
  if (!m) return undefined;
  let text = m[2].replace(RE.newlineGlobal, ' ');
  const hasNonSpace = RE.nonSpace.test(text);
  const wrapped = text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ';
  if (hasNonSpace && wrapped) text = text.substring(1, text.length - 1);
  return { type: 'codespan', raw: m[0], text };
}

function autolinkTok(src) {
  const m = INLINE.autolink.exec(src);
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
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function urlTok(src) {
  const m = INLINE.url.exec(src);
  if (!m) return undefined;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let cur = m[0];
    for (;;) {
      const back = INLINE.urlBackpedal.exec(cur)?.[0] ?? '';
      if (back === cur) break;
      cur = back;
    }
    text = cur;
    href = m[1] === 'www.' ? 'http://' + cur : cur;
  }
  return { type: 'link', raw: text, text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function tagTok(lexer, src) {
  const m = INLINE.tag.exec(src);
  if (!m) return undefined;
  if (!lexer.state.inLink && RE.startATag.test(m[0])) lexer.state.inLink = true;
  else if (lexer.state.inLink && RE.endATag.test(m[0])) lexer.state.inLink = false;
  if (!lexer.state.inRawBlock && RE.startPreTag.test(m[0])) lexer.state.inRawBlock = true;
  else if (lexer.state.inRawBlock && RE.endPreTag.test(m[0])) lexer.state.inRawBlock = false;
  return { type: 'html', raw: m[0], inLink: lexer.state.inLink, inRawBlock: lexer.state.inRawBlock, block: false, text: m[0] };
}

// Could `src` start with an extended autolink? The full URL regex is
// only attempted when this says yes: www., an http/https/ftp scheme,
// mailto:/xmpp:, or an '@' inside the characters a bare email address may
// start with. Anything else cannot match, so the attempt is skipped.
// (Checked with charCodeAt so no substring is allocated per token.)
function urlPossible(src) {
  if (src.startsWith('www.')) return true;
  if (schemeAt(src, 0)) return true;
  const c0 = src.charCodeAt(0) | 32;
  if (c0 === 109 && (src.charCodeAt(1) | 32) === 97 && (src.charCodeAt(2) | 32) === 105 &&
      (src.charCodeAt(3) | 32) === 108 && (src.charCodeAt(4) | 32) === 116 &&
      (src.charCodeAt(5) | 32) === 111 && src.charCodeAt(6) === 58) return true; // mailto:
  if (c0 === 120 && (src.charCodeAt(1) | 32) === 109 && (src.charCodeAt(2) | 32) === 112 &&
      (src.charCodeAt(3) | 32) === 112 && src.charCodeAt(4) === 58) return true; // xmpp:
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 64) return true; // @
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
        c === 46 || c === 95 || c === 43 || c === 45) continue;
    return false;
  }
  return false;
}

// Email local-part characters (the class the reference text scanner uses
// for its email lookaheads): letters, digits and . ! # $ % & ' * + / = ? _ ` { | } ~ -
function isEmailLocal(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    code === 46 || code === 33 || code === 35 || code === 36 || code === 37 || code === 38 ||
    code === 39 || code === 42 || code === 43 || code === 47 || code === 61 || code === 63 ||
    code === 95 || code === 96 || code === 123 || code === 124 || code === 125 || code === 126 || code === 45;
}

function isAlnum(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

// Does an email address (local part + '@') start at position `i`?
function emailStartsAt(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && isEmailLocal(src.charCodeAt(j))) j++;
  return j > i && j < n && src.charCodeAt(j) === 64;
}

// Does a run of two or more spaces starting at `i` end in a newline?
function hardBreakAt(src, i) {
  let j = i;
  const n = src.length;
  while (j < n && src.charCodeAt(j) === 32) j++;
  return j - i >= 2 && j < n && src.charCodeAt(j) === 10;
}

// Does http://, https:// or ftp:// start at `i` (case-insensitive)?
function schemeAt(src, i) {
  const c0 = src.charCodeAt(i) | 32;
  if (c0 === 104) { // h: http or https
    if ((src.charCodeAt(i + 1) | 32) !== 116) return false;
    if ((src.charCodeAt(i + 2) | 32) !== 116) return false;
    if ((src.charCodeAt(i + 3) | 32) !== 112) return false;
    let j = i + 4;
    if ((src.charCodeAt(j) | 32) === 115) j++;
    return src.charCodeAt(j) === 58 && src.charCodeAt(j + 1) === 47 && src.charCodeAt(j + 2) === 47;
  }
  if (c0 === 102) { // f: ftp
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
  return p === 32 || p === 9 || p === 10 || p === 11 || p === 12 || p === 13 ||
    p === 42 || p === 95 || p === 126 || p === 40;
}

// Character-class tables for the plain-text scanner (index by char code;
// out-of-range codes read as undefined, which is falsy, so non-ASCII
// characters simply never match).
const TRIGGER_CHARS = new Uint8Array(128);
for (const c of [92, 60, 33, 91, 96, 42, 126, 95]) TRIGGER_CHARS[c] = 1;
const TRIGGER_RE = /[\\<!\[`*~_]/g;
const EMAIL_LOCAL_CHARS = new Uint8Array(128);
for (let c = 48; c <= 57; c++) EMAIL_LOCAL_CHARS[c] = 1;
for (let c = 65; c <= 90; c++) EMAIL_LOCAL_CHARS[c] = 1;
for (let c = 97; c <= 122; c++) EMAIL_LOCAL_CHARS[c] = 1;
for (const c of [46, 33, 35, 36, 37, 38, 39, 42, 43, 47, 61, 63, 95, 96, 123, 124, 125, 126, 45]) EMAIL_LOCAL_CHARS[c] = 1;
const ALNUM_CHARS = new Uint8Array(128);
for (let c = 48; c <= 57; c++) ALNUM_CHARS[c] = 1;
for (let c = 65; c <= 90; c++) ALNUM_CHARS[c] = 1;
for (let c = 97; c <= 122; c++) ALNUM_CHARS[c] = 1;
// ASCII whitespace or punctuation, except * and _ (the left-delimiter
// test excludes those two): the Unicode regex is only needed for a
// non-ASCII previous character.
const LDELIM_PUNCT_ASCII = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) LDELIM_PUNCT_ASCII[c] = 1;
for (let c = 33; c <= 47; c++) if (c !== 42) LDELIM_PUNCT_ASCII[c] = 1;
for (let c = 58; c <= 64; c++) LDELIM_PUNCT_ASCII[c] = 1;
for (let c = 91; c <= 96; c++) if (c !== 95) LDELIM_PUNCT_ASCII[c] = 1;
for (let c = 123; c <= 126; c++) LDELIM_PUNCT_ASCII[c] = 1;
// Is `ch` (one code point, possibly '') punctuation or whitespace other
// than * or _? ASCII is a table lookup; anything else needs the regex.
function isLDelimPunct(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return LDELIM_PUNCT_ASCII[c] === 1;
  return RE.ldelimPunct.test(ch);
}
// Is `prev` (one code point, possibly '') alphanumeric? ASCII is a range
// check; anything else needs the Unicode test.
function isPrevAlnum(prev) {
  const c = prev.charCodeAt(0);
  if (c < 128) return isAlnum(c);
  return RE.unicodeAlnum.test(prev);
}

// Stops that can end a plain-text token before the next trigger
// character: a scheme:// URL, www., mailto:/xmpp:, an email address, or a
// hard-break run of two or more spaces before a newline. One native scan
// finds the next occurrence of any of them; each is then validated in
// place. (An email's '@' may sit after the next trigger while its local
// part starts before it — that case is handled separately below.)
const RE_AUTOLINK_STOPS = /:\/\/|www\.|mailto:|xmpp:|@| {2,}\n/g;

// Length of the plain-text token starting at src[0]: a hand-written
// equivalent of the reference text regex. The first character (or a
// backtick / tilde run) is always consumed; the scan then stops before
// any inline-construct trigger, autolink trigger, or hard break, or just
// after the single character before one of those. `flags` are the cheap
// necessary conditions computed once per inline source (whether it
// contains '@', '://', 'www.', 'mailto:'/'xmpp:' or '  \n' at all), so
// the per-character loop only tests what could possibly fire.
function textEnd(src, flags) {
  const n = src.length;
  if (n === 0) return 0;
  // A lone non-alphanumeric character before mailto: / xmpp: is its own token.
  if (!ALNUM_CHARS[src.charCodeAt(0)] &&
      (src.startsWith('mailto:', 1) || src.startsWith('xmpp:', 1))) return 1;
  let i = 0;
  const c0 = src.charCodeAt(0);
  if (c0 === 96) {
    while (i < n && src.charCodeAt(i) === 96) i++;
  } else if (c0 === 126) {
    while (i < n && src.charCodeAt(i) === 126) i++;
  } else {
    i = 1;
  }
  if (i >= n) return n;
  // Next trigger character (or end of string).
  TRIGGER_RE.lastIndex = i;
  const tm = TRIGGER_RE.exec(src);
  const T = tm ? tm.index : n;
  // No autolink or hard-break stop can fire anywhere in this source: the
  // token ends at the next trigger character.
  if (!flags.hasAutolink) {
    return T;
  }
  let stop = T;
  if (T > i) {
    // Scan only up to the next trigger: every stop starts before it.
    // A match's characters are never trigger characters, so a match
    // starting in [i, T) also ends before T.
    const seg = src.slice(i, T);
    const rx = RE_AUTOLINK_STOPS;
    rx.lastIndex = 0;
    let prevAt = -1;
    let m;
    while ((m = rx.exec(seg)) !== null) {
      const j = i + m.index;
      const first = m[0].charCodeAt(0);
      if (first === 58) { // '://' — a scheme starts 3-5 chars before it
        if (j - 5 >= stop) break;
        for (let d = 5; d >= 3; d--) {
          const p = j - d;
          if (p >= i && p < stop && schemeAt(src, p)) { stop = p; break; }
        }
      } else if (first === 64) { // '@' — stop at the email local part's start
        if (prevAt >= stop) break;
        let s = j;
        while (s > i && EMAIL_LOCAL_CHARS[src.charCodeAt(s - 1)]) s--;
        if (s < j && s < stop) stop = s;
        prevAt = j;
      } else if (first === 119) { // 'www.'
        if (j >= stop) break;
        if (wwwAt(src, j)) stop = j;
      } else if (first === 109 || first === 120) { // 'mailto:' / 'xmpp:'
        if (j >= stop) break;
        if (j > i && !ALNUM_CHARS[src.charCodeAt(j - 1)]) stop = j;
      } else { // '  +\n' — stop at the first space of the hard-break run
        if (j >= stop) break;
        stop = j;
      }
    }
  }
  // An email local-part run may cross the trigger at T (its '@' sits
  // after T while the local part starts before it). That can only happen
  // when the trigger character itself is an email-local character.
  if (flags.hasAt && stop > i && T < n && EMAIL_LOCAL_CHARS[src.charCodeAt(T)]) {
    let j = T;
    while (j < n && EMAIL_LOCAL_CHARS[src.charCodeAt(j)]) j++;
    if (j < n && src.charCodeAt(j) === 64) {
      let s = j;
      while (s > i && EMAIL_LOCAL_CHARS[src.charCodeAt(s - 1)]) s--;
      if (s < stop) stop = s;
    }
  }
  return stop;
}

/* ------------------------------------------------------------------ */
/* block tokenizers                                                    */
/* ------------------------------------------------------------------ */

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
// them is anchored with up to `maxLead` spaces, so one can only match when
// the first non-space character (a tab or too much indent ends the search)
// starts a block construct; otherwise all six are skipped. Each regex can
// only match when that first character is its own, so only the regexes
// for that character are attempted.
function lineBreaksItem(line, maxLead, fenceRx, headingRx, htmlRx, quoteRx, bulletRx, hrRx) {
  for (let i = 0; i <= maxLead; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) continue;
    if (c === 96 || c === 126) return fenceRx.test(line);
    if (c === 35) return headingRx.test(line);
    if (c === 60) return htmlRx.test(line);
    if (c === 62) return quoteRx.test(line);
    if (c === 42 || c === 45) return bulletRx.test(line) || hrRx.test(line);
    if (c === 43 || (c >= 48 && c <= 57)) return bulletRx.test(line);
    if (c === 95) return hrRx.test(line);
    return false;
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

// Could `src` hold a table? The second line must be a delimiter row:
// at most three leading spaces, then only pipes, colons, dashes, spaces
// and tabs, with at least one dash.
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

// Could `src` hold a setext heading? Some line after the first, before the
// first blank line, must look like an underline: at most three spaces,
// then only '=' or '-' (and spaces/tabs) to the end of the line.
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
      while (k < src.length) {
        const ch = src[k];
        if (ch === '=' || ch === '-' || ch === ' ' || ch === '\t') k++;
        else break;
      }
      if (k === src.length || src[k] === '\n') return true;
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

// UTF-16 length of the first code point of `s` (1, or 2 for astral planes).
function firstCharLen(s) {
  const c = s.charCodeAt(0);
  return c >= 0xD800 && c <= 0xDBFF && s.length > 1 ? 2 : 1;
}

// The code point ending at index `i` of `s` (exclusive): one UTF-16 unit,
// or two when the last two units form a surrogate pair.
function lastCodePointBefore(s, i) {
  const lo = s.charCodeAt(i - 1);
  if (lo >= 0xDC00 && lo <= 0xDFFF && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xD800 && hi <= 0xDBFF) return s.slice(i - 2, i);
  }
  return s[i - 1];
}

function fenceDedent(raw, code) {
  const m = raw.match(RE.fenceIndent);
  if (m === null) return code;
  const indent = m[1];
  return code.split('\n').map((line) => {
    const sp = line.match(RE.leadingSpaces);
    if (sp === null) return line;
    return line.slice(Math.min(sp[0].length, indent.length));
  }).join('\n');
}

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.hasLinks = false;
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this.inlineQueue = [];
    this.maskStack = [];
    this.normCache = new Map();
  }

  get links() {
    return this.tokens.links;
  }

  // Memoized label normalization: reference labels repeat heavily, and
  // the fold (trim + whitespace collapse + case fold) is pure, so the
  // cache is per-parse and never crosses cases.
  normLabel(s) {
    const cache = this.normCache;
    let v = cache.get(s);
    if (v === undefined) {
      v = normLabel(s);
      cache.set(s, v);
    }
    return v;
  }

  // Queue an inline source to be tokenized after the block pass.
  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  lex(src) {
    if (src.includes('\r')) src = src.replace(RE.crlf, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const item = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(item.src, item.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  inlineTokens(src, tokens = []) {
    if (!src) return tokens;
    // Fast path: plain text with no inline construct, no escapable
    // character and no autolink trigger is a single text token, verbatim.
    if (!RE_PLAIN_INLINE.test(src)) {
      tokens.push({ type: 'text', raw: src, text: src, escaped: false });
      return tokens;
    }
    const savedParen = this.state.linkParenPossible;
    this.state.linkParenPossible = savedParen && src.includes(')');
    try {
      // includes() substring search beats the equivalent regex tests
      // here (measured ~2x on real paragraphs).
      const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
      const masked = needsMask ? maskInline(src, this) : src;
      // Without an emphasis delimiter there can be no closer, so the
      // scan is skipped; the pushed entry still carries maskedSrc so
      // closerIndex matches it instead of re-scanning.
      this.maskStack.push(needsMask ? scanClosers(masked) : { maskedSrc: src, em: NO_CLOSERS_EM, del: -1 });
      // Cheap necessary conditions for the plain-text scanner's autolink
      // and hard-break stops, computed once for the whole source: whether
      // any stop pattern occurs at all, and whether '@' occurs (an email
      // local part may start before the next trigger character).
      const hasAt = src.includes('@');
      const flags = {
        hasAt,
        hasAutolink: hasAt || src.includes('://') || src.includes('www.') || src.includes('mailto:') || src.includes('xmpp:') || src.includes('  \n'),
      };
      // The mask stack is popped right after the scan: if the scan
      // throws, the whole parse aborts and this Lexer is discarded, so
      // no cleanup is needed on that path.
      const result = this.inlineScan(src, masked, tokens, flags);
      this.maskStack.pop();
      return result;
    } finally {
      this.state.linkParenPossible = savedParen;
    }
  }

  inlineScan(src, masked, tokens, flags) {
    let prevWasText = false;
    let prevChar = '';
    let shortest = Infinity;
    while (src) {
      if (src.length < shortest) shortest = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      if (!prevWasText) prevChar = '';
      prevWasText = false;
      // Dispatch on the first character: at most two inline constructs can
      // start with any given character, so most attempts are skipped.
      const c = src.charCodeAt(0);
      let tok;
      if (c === 92) { // backslash: escape, or a backslash hard break
        if (tok = INLINE.escape.exec(src)) {
          tok = { type: 'escape', raw: tok[0], text: tok[1] };
          src = src.slice(tok.raw.length);
          tokens.push(tok);
          continue;
        }
        if (tok = INLINE.br.exec(src)) {
          tok = { type: 'br', raw: tok[0] };
          src = src.slice(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      } else if (c === 60) { // <: raw HTML tag or autolink
        if (tok = tagTok(this, src)) {
          src = src.slice(tok.raw.length);
          tokens.push(tok);
          continue;
        }
        if (tok = autolinkTok(src)) {
          src = src.slice(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      } else if (c === 91 || c === 33) { // [ or !: link or reference link
        if (tok = linkTok(this, src)) {
          src = src.slice(tok.raw.length);
          tokens.push(tok);
          continue;
        }
        if (tok = reflinkTok(this, src)) {
          src = src.slice(tok.raw.length);
          const last = tokens[tokens.length - 1];
          if (tok.type === 'text' && last?.type === 'text') {
            last.raw += tok.raw;
            last.text += tok.text;
          } else tokens.push(tok);
          continue;
        }
      } else if (c === 96) { // backtick: code span
        if (tok = codespanTok(src)) {
          src = src.slice(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      } else if (c === 42 || c === 95) { // * or _: emphasis
        if (tok = emStrongTok(this, src, masked, prevChar)) {
          src = src.slice(tok.raw.length);
          tokens.push(tok);
          continue;
        }
        // An email address can start with '_' (its local part allows it),
        // so a failed emphasis attempt must still try the extended
        // autolink, as the reference dispatch does after emStrong.
        if (c === 95 && !this.state.inLink && urlPossible(src)) {
          if (tok = urlTok(src)) {
            src = src.slice(tok.raw.length);
            tokens.push(tok);
            continue;
          }
        }
      } else if (c === 126) { // ~: strikethrough
        if (tok = delTok(this, src, masked, prevChar)) {
          src = src.slice(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      } else if (c === 32) { // space: two-space hard break
        if (tok = INLINE.br.exec(src)) {
          tok = { type: 'br', raw: tok[0] };
          src = src.slice(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      } else if (!this.state.inLink && urlPossible(src)) {
        if (tok = urlTok(src)) {
          src = src.slice(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      }
      // Plain text: find the token end, slice it once, unescape, and merge
      // with the previous text token when adjacent.
      const len = textEnd(src, flags);
      if (len) {
        const m0 = src.slice(0, len);
        const inRaw = this.state.inRawBlock;
        const text = inRaw ? m0 : unescape(m0);
        src = src.slice(len);
        if (m0.charCodeAt(m0.length - 1) !== 95) prevChar = m0.slice(-1);
        prevWasText = true;
        const last = tokens[tokens.length - 1];
        if (last?.type === 'text') {
          last.raw += m0;
          last.text += text;
        } else tokens.push({ type: 'text', raw: m0, text, escaped: inRaw });
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    return tokens;
  }

  blockTokens(src, tokens, inBlock = false) {
    let shortest = Infinity;
    while (src) {
      if (src.length < shortest) shortest = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let tok;
      // First character of the remaining source: most block constructs
      // can only start with one specific character (after at most three
      // leading spaces), so their regexes are only attempted when that
      // character could possibly be there.
      const c0 = firstNonSpaceChar(src);
      const s0 = src.charCodeAt(0);
      if ((s0 === 32 || s0 === 9 || s0 === 10) && (tok = this.spaceTok(src))) {
        src = src.slice(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((s0 === 32 || s0 === 9) && (tok = this.indentedCodeTok(src))) {
        src = src.slice(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else tokens.push(tok);
        continue;
      }
      // Cheap necessary conditions, so the big regexes below only run when
      // they could possibly match.
      if ((c0 === 96 || c0 === 126) && (tok = this.fencesTok(src))) {
        src = src.slice(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (c0 === 35 && (tok = this.headingTok(src))) {
        src = src.slice(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((c0 === 45 || c0 === 95 || c0 === 42) && (tok = this.hrTok(src))) {
        src = src.slice(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (c0 === 62 && (tok = this.blockquoteTok(src))) {
        src = src.slice(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((c0 === 42 || c0 === 43 || c0 === 45 || (c0 >= 48 && c0 <= 57)) && (tok = this.listTok(src))) {
        src = src.slice(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (c0 === 60 && (tok = this.htmlTok(src))) {
        src = src.slice(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (c0 === 91 && (tok = this.defTok(src))) {
        src = src.slice(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.raw;
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else {
          if (!this.tokens.links[tok.tag]) {
            this.tokens.links[tok.tag] = { href: tok.href, title: tok.title };
            this.hasLinks = true;
          }
          tokens.push(tok);
        }
        continue;
      }
      if (maybeTable(src) && (tok = this.tableTok(src))) {
        src = src.slice(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (maybeSetext(src) && (tok = this.setextTok(src))) {
        src = src.slice(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (this.state.top && (tok = this.paragraphTok(src))) {
        const last = tokens[tokens.length - 1];
        if (inBlock && last?.type === 'paragraph') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else tokens.push(tok);
        inBlock = false;
        src = src.slice(tok.raw.length);
        continue;
      }
      if (tok = this.textTok(src)) {
        src = src.slice(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else tokens.push(tok);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }

  spaceTok(src) {
    const m = BLOCK.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
    return undefined;
  }

  indentedCodeTok(src) {
    const m = BLOCK.indentedCode.exec(src);
    if (!m) return undefined;
    const raw = stripTrailingBlanks(m[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(RE.codeRemoveIndent, '') };
  }

  fencesTok(src) {
    const m = BLOCK.fences.exec(src);
    if (!m) return undefined;
    const lang = m[2] ? m[2].trim().replace(INLINE.anyPunct, '$1') : m[2];
    return { type: 'code', raw: m[0], lang, text: fenceDedent(m[0], m[3] || '') };
  }

  headingTok(src) {
    const m = BLOCK.heading.exec(src);
    if (!m) return undefined;
    let text = m[2].trim();
    if (RE.endingHash.test(text)) {
      const stripped = rtrim(text, '#');
      if (!stripped || RE.endsSpaceTab.test(stripped)) text = stripped.trim();
    }
    return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[1].length, text, tokens: this.inline(text) };
  }

  hrTok(src) {
    const m = BLOCK.hr.exec(src);
    if (!m) return undefined;
    return { type: 'hr', raw: rtrim(m[0], '\n') };
  }

  htmlTok(src) {
    const m = BLOCK.html.exec(src);
    if (!m) return undefined;
    const raw = stripTrailingBlanks(m[0]);
    return {
      type: 'html', block: true, raw,
      pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
      text: raw,
    };
  }

  defTok(src) {
    const m = BLOCK.def.exec(src);
    if (!m) return undefined;
    if (!RE.startAngle.test(m[2]) && parenBalance(m[2], '()') !== -1) return undefined;
    const tag = this.normLabel(m[1]);
    const hrefRaw = m[2] ? m[2].replace(RE.hrefBrackets, '$1') : '';
    const href = hrefRaw.includes('\\') ? hrefRaw.replace(INLINE.anyPunct, '$1') : hrefRaw;
    const titleRaw = m[3] ? m[3].substring(1, m[3].length - 1) : m[3];
    const title = titleRaw && titleRaw.includes('\\') ? titleRaw.replace(INLINE.anyPunct, '$1') : titleRaw;
    return { type: 'def', tag, raw: rtrim(m[0], '\n'), href, title };
  }

  tableTok(src) {
    const m = BLOCK.table.exec(src);
    if (!m || !RE.tablePipe.test(m[2])) return undefined;
    const headerCells = splitCells(m[1]);
    const aligns = m[2].replace(RE.tableEdge, '').split('|');
    const bodyRows = m[3]?.trim() ? m[3].replace(RE.tableRowBlank, '').split('\n') : [];
    const table = { type: 'table', raw: rtrim(m[0], '\n'), header: [], align: [], rows: [] };
    if (headerCells.length !== aligns.length) return undefined;
    for (const a of aligns) {
      if (RE.tableAlignRight.test(a)) table.align.push('right');
      else if (RE.tableAlignCenter.test(a)) table.align.push('center');
      else if (RE.tableAlignLeft.test(a)) table.align.push('left');
      else table.align.push(null);
    }
    for (let i = 0; i < headerCells.length; i++) {
      table.header.push({ text: headerCells[i], tokens: this.inline(headerCells[i]), header: true, align: table.align[i] });
    }
    for (const row of bodyRows) {
      table.rows.push(splitCells(row, table.header.length).map((cell, j) => ({
        text: cell, tokens: this.inline(cell), header: false, align: table.align[j],
      })));
    }
    return table;
  }

  setextTok(src) {
    const m = BLOCK.setext.exec(src);
    if (!m) return undefined;
    const text = m[1].trim();
    return {
      type: 'heading', raw: rtrim(m[0], '\n'),
      depth: m[2].charAt(0) === '=' ? 1 : 2,
      text, tokens: this.inline(text),
    };
  }

  paragraphTok(src) {
    const m = BLOCK.paragraph.exec(src);
    if (!m) return undefined;
    const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    return { type: 'paragraph', raw: m[0], text, tokens: this.inline(text) };
  }

  textTok(src) {
    const m = BLOCK.text.exec(src);
    if (!m) return undefined;
    return { type: 'text', raw: m[0], text: m[0], tokens: this.inline(m[0]) };
  }

  blockquoteTok(src) {
    const m = BLOCK.blockquote.exec(src);
    if (!m) return undefined;
    let lines = rtrim(m[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    for (; lines.length > 0;) {
      let inQuote = false;
      const chunk = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (RE.blockquoteStart.test(lines[p])) {
          chunk.push(lines[p]);
          inQuote = true;
        } else if (!inQuote) chunk.push(lines[p]);
        else break;
      }
      lines = lines.slice(p);
      const chunkStr = chunk.join('\n');
      const inner = chunkStr
        .replace(RE.blockquoteMarkerWs, (g, b, ws) => b + expandTabs(ws, b.length))
        .replace(RE.blockquoteSetext, '\n    $1')
        .replace(RE.blockquoteSetext2, '');
      raw = raw ? `${raw}\n${chunkStr}` : chunkStr;
      text = text ? `${text}\n${inner}` : inner;
      const savedTop = this.state.top;
      this.state.top = true;
      this.blockTokens(inner, tokens, true);
      this.state.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens[tokens.length - 1];
      if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' ||
          last?.type === 'html' || last?.type === 'table') break;
      if (last?.type === 'blockquote') {
        const prev = last;
        const rest = lines.join('\n');
        const merged = prev.raw + '\n' + rest.replace(RE.blockquoteSetext2, '');
        const reparsed = this.blockquoteTok(merged);
        tokens[tokens.length - 1] = reparsed;
        const tail = merged.substring(reparsed.raw.length).replace(/^\n/, '');
        const tailLines = tail ? tail.split('\n').length : 0;
        const consumed = tailLines ? lines.slice(0, -tailLines) : lines;
        if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
        text = text.substring(0, text.length - prev.text.length) + reparsed.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && RE.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (last?.type === 'list') {
        const prev = last;
        const merged = prev.raw + '\n' + lines.join('\n');
        const reparsed = this.listTok(merged);
        tokens[tokens.length - 1] = reparsed;
        const extra = reparsed.raw.length > prev.raw.length
          ? merged.slice(prev.raw.length + 1, reparsed.raw.length).split('\n').length
          : 0;
        if (extra > 0) {
          const extraLines = lines.slice(0, extra).join('\n');
          raw = `${raw}\n${extraLines}`;
          text = `${text}\n${extraLines}`;
        }
        lines = lines.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  listTok(src) {
    const m = BLOCK.listStart.exec(src);
    if (!m) return undefined;
    const fullSrc = src;
    const consumed = () => fullSrc.length - src.length;
    const marker = m[1].trim();
    const ordered = marker.length > 1;
    const list = {
      type: 'list', raw: '', ordered,
      start: ordered ? +marker.slice(0, -1) : '',
      loose: false, items: [],
    };
    const markerPattern = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
    const itemRx = listItemRegex(markerPattern);
    let sawDoubleBlank = false;
    while (src) {
      let blankAfter = false;
      let itemText = '';
      const itemMatch = itemRx.exec(src);
      if (!itemMatch || BLOCK.hr.test(src)) break;
      const itemStart = consumed();
      src = src.substring(itemMatch[0].length);
      const nl2 = itemMatch[2].indexOf('\n');
      const firstLine = nl2 === -1 ? itemMatch[2] : itemMatch[2].slice(0, nl2);
      const markerWidth = itemMatch[1].length;
      const firstContent = firstLine.includes('\t')
        ? firstLine.replace(RE.leadingSpaceTab, (v) => expandTabs(v, markerWidth))
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
      if (isEmpty && RE.blankLine.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        blankAfter = true;
      }
      if (!blankAfter) {
        const bulletRx = indentRegex('bullet', contentIndent);
        const hrRx = indentRegex('hr', contentIndent);
        const fenceRx = indentRegex('fences', contentIndent);
        const headingRx = indentRegex('heading', contentIndent);
        const htmlRx = indentRegex('html', contentIndent);
        const quoteRx = indentRegex('blockquote', contentIndent);
        const maxLead = Math.max(0, Math.min(3, contentIndent - 1));
        let prevContent = firstContent;
        let prevLead = leadingWidth(firstContent);
        let blankLine = isEmpty;
        for (; src;) {
          const nl = src.indexOf('\n');
          const line = nl === -1 ? src : src.slice(0, nl);
          if (lineBreaksItem(line, maxLead, fenceRx, headingRx, htmlRx, quoteRx, bulletRx, hrRx)) break;
          const expanded = line.includes('\t')
            ? line.replace(RE.leadingSpaceTab, (v) => expandTabs(v, 0))
            : line;
          // leadingSpaces(expanded) also tells whether the line is blank:
          // expanded holds only spaces exactly when the line holds only
          // spaces and tabs
          const lead = leadingSpaces(expanded);
          const lineBlank = lead === expanded.length;
          const sliced = expanded.slice(contentIndent);
          if (lead >= contentIndent || lineBlank) {
            itemText += '\n' + sliced;
          } else {
            if (blankLine || prevLead >= 4 ||
                prevLineBreaksItem(prevContent, fenceRx, headingRx, htmlRx, hrRx)) break;
            const fc = firstNonSpaceChar(line);
            const setextLine = (fc === 61 || fc === 45) && /^ {0,3}(?:=+|-+) *$/.test(line) &&
              BLOCK.setext.test(`${prevContent}\n${line}`)
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
        task: RE.listIsTask.test(itemText),
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
      this.state.top = false;
      item.tokens = this.blockTokens(item.text, []);
      if (!list.loose) {
        for (const t of item.tokens) {
          if (t.type === 'space' && RE.anyLine.test(t.raw)) { list.loose = true; break; }
        }
      }
    }
    for (const item of list.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(RE.listReplaceTask, '');
        first.raw = first.raw.replace(RE.listReplaceTask, '');
        first.text = first.text.replace(RE.listReplaceTask, '');
        for (let g = this.inlineQueue.length - 1; g >= 0; g--) {
          if (RE.listIsTask.test(this.inlineQueue[g].src)) {
            this.inlineQueue[g].src = this.inlineQueue[g].src.replace(RE.listReplaceTask, '');
            break;
          }
        }
        const cb = RE.taskCheckbox.exec(item.raw);
        if (cb) {
          const checkbox = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
          item.checked = checkbox.checked;
          if (list.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) &&
                'tokens' in item.tokens[0] && item.tokens[0].tokens) {
              item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
              item.tokens[0].text = checkbox.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(checkbox);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
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

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function renderCode(tok) {
  const lang = (tok.lang || '').match(RE.notSpaceStart)?.[0] || '';
  const body = tok.text ? tok.text.replace(RE.endingNewline, '') + '\n' : '';
  const inner = esc(body, true);
  return lang
    ? `<pre><code class="language-${esc(lang)}">${inner}</code></pre>\n`
    : `<pre><code>${inner}</code></pre>\n`;
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return `${open}${renderInline(cell.tokens)}</${tag}>\n`;
}

function renderTable(tok) {
  let head = '';
  for (const cell of tok.header) head += renderTableCell(cell);
  const thead = `<tr>\n${head}</tr>\n`;
  let body = '';
  for (const row of tok.rows) {
    let cells = '';
    for (const cell of row) cells += renderTableCell(cell);
    body += `<tr>\n${cells}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return `<table>\n<thead>\n${thead}</thead>\n${body}</table>\n`;
}

function renderList(tok) {
  const tag = tok.ordered ? 'ol' : 'ul';
  const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
  let items = '';
  for (const item of tok.items) items += `<li>${renderBlocks(item.tokens)}</li>\n`;
  return `<${tag}${start}>\n${items}</${tag}>\n`;
}

function renderCheckbox(tok) {
  return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderBlocks(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`; break;
      case 'code': out += renderCode(tok); break;
      case 'table': out += renderTable(tok); break;
      case 'blockquote': out += `<blockquote>\n${renderBlocks(tok.tokens)}</blockquote>\n`; break;
      case 'list': out += renderList(tok); break;
      case 'checkbox': out += renderCheckbox(tok); break;
      case 'html': out += tok.text; break;
      case 'def': break;
      case 'paragraph': out += `<p>${renderInline(tok.tokens)}</p>\n`; break;
      case 'text': out += ('tokens' in tok && tok.tokens) ? renderInline(tok.tokens) : ('escaped' in tok && tok.escaped) ? tok.text : esc(tok.text); break;
      default: throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

function renderLink(tok) {
  const inner = tok.autolink ? esc(tok.text, true) : renderInline(tok.tokens);
  const cleaned = cleanUrl(tok.href);
  if (cleaned === null) return inner;
  let out = `<a href="${esc(cleaned, tok.autolink)}"`;
  if (tok.title) out += ` title="${esc(tok.title)}"`;
  return out + `>${inner}</a>`;
}

function renderImage(tok) {
  const alt = tok.tokens ? renderInlineText(tok.tokens) : tok.text;
  const cleaned = cleanUrl(tok.href);
  if (cleaned === null) return esc(alt);
  let out = `<img src="${esc(cleaned)}" alt="${esc(alt)}"`;
  if (tok.title) out += ` title="${esc(tok.title)}"`;
  return out + '>';
}

function renderInline(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape': out += esc(tok.text); break;
      case 'html': out += tok.text; break;
      case 'link': out += renderLink(tok); break;
      case 'image': out += renderImage(tok); break;
      case 'checkbox': out += renderCheckbox(tok); break;
      case 'strong': out += `<strong>${renderInline(tok.tokens)}</strong>`; break;
      case 'em': out += `<em>${renderInline(tok.tokens)}</em>`; break;
      case 'codespan': out += `<code>${esc(tok.text, true)}</code>`; break;
      case 'br': out += '<br>'; break;
      case 'del': out += `<del>${renderInline(tok.tokens)}</del>`; break;
      case 'text': out += ('tokens' in tok && tok.tokens) ? renderInline(tok.tokens) : ('escaped' in tok && tok.escaped) ? tok.text : esc(tok.text); break;
      default: throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

// Plain-text rendering, used for image alt text: no tags, no escaping,
// line breaks vanish.
function renderInlineText(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += tok.tokens ? renderInlineText(tok.tokens) : tok.text;
        break;
      case 'codespan':
      case 'html':
      case 'text':
      case 'escape':
        out += tok.text;
        break;
      case 'br':
        break;
      case 'checkbox':
        out += tok.raw;
        break;
      default: throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* entry point                                                         */
/* ------------------------------------------------------------------ */

// Render `markdown` to the HTML marked 18.1.3 produces with its defaults.
// Stateless: every call builds a fresh lexer and keeps nothing between calls.
export function parse(markdown) {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return renderBlocks(tokens);
}
