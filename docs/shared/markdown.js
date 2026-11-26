// Markdown as the models write it, rendered as DOM nodes: the responses,
// reasoning and judgments shown in a judged task's view (task-examples.js).
//
// The common parts of CommonMark — paragraphs, headings (ATX and setext),
// thematic breaks, block quotes, nested lists, fenced code, emphasis, code
// spans, links, backslash escapes, entities — plus GFM tables and
// strikethrough. Every line break is kept (a chat's "breaks" mode), and a
// list item's lines may sit 2 spaces in under any marker (as models nest
// their lists). Left out: indented code blocks (an indented line is text),
// reference links, raw HTML.
//
// Text only ever becomes text nodes: an HTML tag in a response shows as
// written, except <br>, which breaks the line. Links open in a new tab, and
// only to http(s) and mailto addresses (anything else is its text); an
// image is its alt text, never loaded.

const MAX_DEPTH = 16;   // nested lists and quotes deeper than this are text

const BLANK = /^[ \t]*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`]*?)[ \t]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const LIST = /^( {0,3})(?:([-*+])|(\d{1,9})([.)]))(?:([ \t]+)(.*))?$/;
const TABLE_DELIM = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const PUNCT = /[\p{P}\p{S}]/u;
const SPACE = /\s/u;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»" };

const isBlank = (line) => BLANK.test(line);
const indentOf = (line) => line.match(/^ */)[0].length;

/** A list item's marker on `line`: {indent, bullet | number and delim,
 *  content, width (the content's indent)}; null if there is none (or the
 *  line is a thematic break). */
function listMarker(line) {
  if (HR.test(line)) return null;
  const m = line.match(LIST);
  if (!m) return null;
  const indent = m[1].length;
  const marker = m[2] || m[3] + m[4];
  const content = m[6] ?? "";
  let spaces = m[5] ? m[5].length : 0;
  if (!m[5] && content) return null;   // ("-foo", "1.5": no marker)
  if (spaces > 4 || !content) spaces = 1;   // (a blank item, or text indented as code: one space)
  return {
    indent, bullet: m[2] || null, number: m[3] ? parseInt(m[3], 10) : null, delim: m[4] || null,
    content: m[5] && m[5].length > 4 ? m[5].slice(1) + content : content,
    width: indent + marker.length + spaces,
  };
}

/** Whether `line` starts a block that ends a paragraph before it (an
 *  ordered list only from 1, and no empty list item, as in CommonMark). */
function interrupts(line) {
  if (FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line)) return true;
  const m = listMarker(line);
  return !!m && m.content.trim() !== "" && (m.bullet || m.number === 1);
}

/** A table row's cells (its outer pipes optional, "\|" a pipe in a cell). */
function cells(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** Whether lines `i` and `i + 1` start a table: a header row and its
 *  delimiter row, with as many cells. */
function tableAt(lines, i) {
  const head = lines[i], delim = lines[i + 1];
  if (delim === undefined || !head.includes("|") || !TABLE_DELIM.test(delim) || !delim.includes("-")) return false;
  if (!delim.includes("|") && !head.trim().startsWith("|")) return false;
  return cells(head).length === cells(delim).length;
}

/** The blocks of `lines` (one level of the document). */
function parseBlocks(lines, depth = 0) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    let m;
    if ((m = line.match(FENCE))) {
      const [, pad, fence] = m;
      const body = [];
      i++;
      const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
      while (i < lines.length && !close.test(lines[i])) {
        body.push(lines[i].slice(Math.min(pad.length, indentOf(lines[i]))));
        i++;
      }
      i++;   // (the closing fence, or the end)
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    if ((m = line.match(ATX))) {
      blocks.push({ type: "heading", level: m[1].length, text: m[2] || "" });
      i++;
      continue;
    }
    if (HR.test(line)) { blocks.push({ type: "hr" }); i++; continue; }
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && !isBlank(lines[i])) {
        if (QUOTE.test(lines[i])) inner.push(lines[i].replace(/^ {0,3}> ?/, ""));
        else if (inner.length && !interrupts(lines[i])) inner.push(lines[i]);   // (a lazy line)
        else break;
        i++;
      }
      blocks.push(depth < MAX_DEPTH ? { type: "quote", children: parseBlocks(inner, depth + 1) } : { type: "para", text: inner.join("\n") });
      continue;
    }
    const marker = listMarker(line);
    if (marker) {
      const list = parseList(lines, i, marker, depth);
      blocks.push(list.block);
      i = list.next;
      continue;
    }
    if (tableAt(lines, i)) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : c.startsWith(":") ? "left" : ""));
      const rows = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|") && !interrupts(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      blocks.push({ type: "table", head, align, rows });
      continue;
    }
    // A paragraph: up to a blank line or a block that interrupts it; a
    // setext underline makes it a heading.
    const text = [line];
    i++;
    let heading = 0;
    while (i < lines.length && !isBlank(lines[i])) {
      const s = lines[i].match(SETEXT);
      if (s && indentOf(lines[i]) < 4) { heading = s[1][0] === "=" ? 1 : 2; i++; break; }
      if (interrupts(lines[i]) || tableAt(lines, i)) break;
      text.push(lines[i]);
      i++;
    }
    const joined = text.join("\n").trim();
    blocks.push(heading ? { type: "heading", level: heading, text: joined } : { type: "para", text: joined });
  }
  return blocks;
}

/** The list that starts at line `i` with `first`'s marker: its items, up to
 *  a line that is neither an item of the same kind nor inside one. */
function parseList(lines, i, first, depth) {
  const ordered = first.number !== null;
  const same = (m) => m && (ordered ? m.delim === first.delim : m.bullet === first.bullet);
  const items = [];
  while (i < lines.length) {
    const m = listMarker(lines[i]);
    if (!same(m) || m.indent > first.indent + 3) break;
    const body = [m.content];
    // Its lines: those set in at least 2 spaces past its marker's start (or
    // as far as its text), blank lines between them, and lazy lines going
    // on with its last paragraph.
    const inside = Math.min(m.width, m.indent + 2);
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) { body.push(""); i++; continue; }
      const ind = indentOf(line);
      if (ind >= inside) { body.push(line.slice(Math.min(ind, m.width))); i++; continue; }
      if (body[body.length - 1] !== "" && !interrupts(line) && !listMarker(line)) { body.push(line.trimStart()); i++; continue; }
      break;
    }
    while (body.length && body[body.length - 1] === "") body.pop();
    items.push(depth < MAX_DEPTH ? parseBlocks(body, depth + 1) : [{ type: "para", text: body.join("\n") }]);
    // (A blank line and then something else ends the list.)
  }
  return { block: { type: "list", ordered, start: first.number, items }, next: i };
}

// ── Inlines ──

/** The flanking of a delimiter run from `before` to `after` (the
 *  characters around it; a line's ends count as spaces). */
function flanking(ch, before, after) {
  const sb = SPACE.test(before), sa = SPACE.test(after);
  const pb = PUNCT.test(before), pa = PUNCT.test(after);
  const left = !sa && (!pa || sb || pb);
  const right = !sb && (!pb || sa || pa);
  if (ch === "_") return { open: left && (!right || pb), close: right && (!left || pa) };
  return { open: left, close: right };
}

/** The end (index past its last backtick) of the next run of exactly `n`
 *  backticks from `from`, or -1. */
function backtickRun(src, from, n) {
  for (let i = src.indexOf("`", from); i !== -1; i = src.indexOf("`", i)) {
    let k = i;
    while (src[k] === "`") k++;
    if (k - i === n) return i;
    i = k;
  }
  return -1;
}

/** A link at `src[i]` ("["): {label, href, end} (end past its ")"), or null. */
function linkAt(src, i) {
  let level = 0, j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") { j++; continue; }
    if (c === "`") {
      let n = 1;
      while (src[j + n] === "`") n++;
      const close = backtickRun(src, j + n, n);
      if (close !== -1) { j = close + n - 1; continue; }
      j += n - 1;
      continue;
    }
    if (c === "[") level++;
    else if (c === "]" && --level === 0) break;
  }
  if (j >= src.length || src[j + 1] !== "(") return null;
  let k = j + 2;
  while (src[k] === " " || src[k] === "\t" || src[k] === "\n") k++;
  let href = "";
  if (src[k] === "<") {
    const close = src.indexOf(">", k);
    if (close === -1 || src.slice(k, close).includes("\n")) return null;
    href = src.slice(k + 1, close);
    k = close + 1;
  } else {
    let parens = 0;
    const startK = k;
    for (; k < src.length; k++) {
      const c = src[k];
      if (c === "\\" && ASCII_PUNCT.test(src[k + 1] || "")) { k++; continue; }
      if (SPACE.test(c)) break;
      if (c === "(") parens++;
      else if (c === ")") { if (parens === 0) break; parens--; }
    }
    href = src.slice(startK, k).replace(/\\([!-/:-@[-`{-~])/g, "$1");
  }
  while (src[k] === " " || src[k] === "\t" || src[k] === "\n") k++;
  const quote = { '"': '"', "'": "'", "(": ")" }[src[k]];
  if (quote) {
    const close = src.indexOf(quote, k + 1);
    if (close === -1) return null;
    k = close + 1;
    while (src[k] === " " || src[k] === "\t" || src[k] === "\n") k++;
  }
  if (src[k] !== ")") return null;
  return { label: src.slice(i + 1, j), href, end: k + 1 };
}

/** An entity's character(s), or null if it is none. */
function entity(name) {
  if (name[0] === "#") {
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
  }
  return ENTITIES[name] ?? null;
}

/** `src`'s inlines: text, code, br, em, strong, del and link nodes. */
function parseInline(src, depth = 0) {
  const nodes = [];
  let text = "";
  const flush = () => { if (text) { nodes.push({ t: "text", v: text }); text = ""; } };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      const next = src[i + 1];
      if (next === "\n") { flush(); nodes.push({ t: "br" }); i += 2; continue; }
      if (next && ASCII_PUNCT.test(next)) { text += next; i += 2; continue; }
      text += c; i++;
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (src[i + n] === "`") n++;
      const close = backtickRun(src, i + n, n);
      if (close === -1) { text += "`".repeat(n); i += n; continue; }
      let code = src.slice(i + n, close).replace(/\n/g, " ");
      if (code.length > 2 && code[0] === " " && code[code.length - 1] === " " && code.trim()) code = code.slice(1, -1);
      flush();
      nodes.push({ t: "code", v: code });
      i = close + n;
      continue;
    }
    if (c === "\n") {
      text = text.replace(/[ \t]+$/, "");
      flush();
      nodes.push({ t: "br" });
      i++;
      while (src[i] === " " || src[i] === "\t") i++;
      continue;
    }
    if (c === "*" || c === "_" || c === "~") {
      let n = 1;
      while (src[i + n] === c) n++;
      const f = flanking(c, i ? src[i - 1] : "\n", src[i + n] ?? "\n");
      if (c === "~" && n !== 2) { text += c.repeat(n); i += n; continue; }
      flush();
      nodes.push({ t: "delim", ch: c, len: n, orig: n, open: f.open, close: f.close });
      i += n;
      continue;
    }
    if ((c === "[" || (c === "!" && src[i + 1] === "[")) && depth < MAX_DEPTH) {
      const image = c === "!";
      const link = linkAt(src, image ? i + 1 : i);
      if (link) {
        flush();
        const label = parseInline(link.label, depth + 1);
        if (image) nodes.push({ t: "text", v: plainText(label) });
        else nodes.push({ t: "link", href: link.href, c: label });
        i = link.end;
        continue;
      }
    }
    if (c === "<") {
      const rest = src.slice(i, i + 2048);
      const auto = rest.match(/^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i);
      if (auto) { flush(); nodes.push({ t: "link", href: auto[1], c: [{ t: "text", v: auto[1] }] }); i += auto[0].length; continue; }
      const br = rest.match(/^<br\s*\/?>/i);
      if (br) { flush(); nodes.push({ t: "br" }); i += br[0].length; continue; }
    }
    if (c === "&") {
      const m = src.slice(i, i + 40).match(/^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/);
      const v = m && entity(m[1]);
      if (v != null) { text += v; i += m[0].length; continue; }
    }
    text += c;
    i++;
  }
  flush();
  return emphasis(nodes);
}

const asText = (d) => ({ t: "text", v: d.ch.repeat(d.len) });

/** Pair the delimiter runs into em, strong and del nodes (CommonMark's
 *  "process emphasis"); the runs left over are text. */
function emphasis(nodes) {
  let ci = 0;
  while (ci < nodes.length) {
    const closer = nodes[ci];
    if (closer.t !== "delim" || !closer.close || !closer.len) { ci++; continue; }
    let oi = ci - 1;
    for (; oi >= 0; oi--) {
      const o = nodes[oi];
      if (o.t !== "delim" || o.ch !== closer.ch || !o.open || !o.len) continue;
      if (closer.ch === "~") { if (o.len === closer.len) break; continue; }
      // (The rule of three: a run that both opens and closes pairs only
      // when the lengths' sum isn't a multiple of 3, unless both are.)
      if ((o.close || closer.open) && (o.orig + closer.orig) % 3 === 0 && (o.orig % 3 || closer.orig % 3)) continue;
      break;
    }
    if (oi < 0) { ci++; continue; }
    const opener = nodes[oi];
    const use = closer.ch === "~" ? 2 : opener.len >= 2 && closer.len >= 2 ? 2 : 1;
    const inner = nodes.slice(oi + 1, ci).map((n) => (n.t === "delim" ? asText(n) : n));
    nodes.splice(oi + 1, ci - oi - 1, { t: closer.ch === "~" ? "del" : use === 2 ? "strong" : "em", c: inner });
    opener.len -= use;
    closer.len -= use;
    ci = oi + 2;
    if (!opener.len) { nodes.splice(oi, 1); ci--; }
    if (!closer.len) nodes.splice(ci, 1);
  }
  return nodes.map((n) => (n.t === "delim" ? asText(n) : n));
}

/** Inline nodes' text, as an image's alt text. */
function plainText(nodes) {
  return nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "br" ? " " : plainText(n.c || []))).join("");
}

// ── DOM ──

function inlines(nodes, parent) {
  for (const n of nodes) {
    if (n.t === "text") parent.append(n.v);
    else if (n.t === "br") parent.append(document.createElement("br"));
    else if (n.t === "code") {
      const code = document.createElement("code");
      code.textContent = n.v;
      parent.append(code);
    } else if (n.t === "link") {
      let a;
      if (/^(https?:\/\/|mailto:)/i.test(n.href)) {
        a = document.createElement("a");
        a.href = n.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow";
      } else a = document.createElement("span");
      inlines(n.c, a);
      parent.append(a);
    } else {
      const e = document.createElement(n.t);
      inlines(n.c, e);
      parent.append(e);
    }
  }
  return parent;
}

function blocks(list, parent) {
  for (const b of list) {
    let e;
    if (b.type === "para") e = inlines(parseInline(b.text), document.createElement("p"));
    else if (b.type === "heading") {
      // (A paragraph of the text's size, in bold: a response's headings
      // stay inside the page's outline and its type sizes.)
      e = inlines(parseInline(b.text), document.createElement("p"));
      e.className = "markdown-heading";
    } else if (b.type === "hr") e = document.createElement("hr");
    else if (b.type === "code") {
      e = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = b.text;
      e.append(code);
    } else if (b.type === "quote") e = blocks(b.children, document.createElement("blockquote"));
    else if (b.type === "list") {
      e = document.createElement(b.ordered ? "ol" : "ul");
      if (b.ordered && b.start !== 1) e.start = b.start;
      for (const item of b.items) e.append(blocks(item, document.createElement("li")));
    } else if (b.type === "table") {
      e = document.createElement("div");
      e.className = "markdown-table";
      const table = document.createElement("table");
      const row = (values, tag) => {
        const tr = document.createElement("tr");
        b.head.forEach((_, k) => {
          const cell = inlines(parseInline(values[k] ?? ""), document.createElement(tag));
          if (b.align[k]) cell.style.textAlign = b.align[k];
          tr.append(cell);
        });
        return tr;
      };
      const thead = document.createElement("thead");
      thead.append(row(b.head, "th"));
      table.append(thead);
      if (b.rows.length) {
        const tbody = document.createElement("tbody");
        for (const r of b.rows) tbody.append(row(r, "td"));
        table.append(tbody);
      }
      e.append(table);
    }
    if (e) parent.append(e);
  }
  return parent;
}

/** `text` (Markdown) as a DocumentFragment. */
export function renderMarkdown(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return blocks(parseBlocks(lines), document.createDocumentFragment());
}
