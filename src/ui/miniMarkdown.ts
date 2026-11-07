/* The sidebar's Markdown renderer, in the plugin and in the browser harness.
 *
 * Deliberately small and deliberately not Obsidian's. What is drawn here was
 * written by a model that may have been fed a hostile note, and Obsidian's
 * renderer hands its output to every plugin's post-processor: Dataview would
 * run a `dataviewjs` block, and an image or a raw tag is fetched the moment
 * it is drawn. This one builds DOM nodes one by one from a fixed set (text,
 * strong, em, code, p, h1-h6, ul, ol, li, pre): nothing the model writes
 * reaches an HTML parser, loads anything, or runs.
 *
 * It covers what the model is asked to produce: paragraphs, lists (nested by
 * indentation), headings, bold, italic, inline code, code blocks. A link or an
 * image is shown as its text.
 */

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }
  | { type: 'code'; text: string };

export type MdBlock =
  | { type: 'paragraph'; children: MdInline[] }
  | { type: 'heading'; level: number; children: MdInline[] }
  /**
   * `depths` and `marks` are present only when some item is indented. `depths`: one nesting level
   * per item, 0 to 3. `marks`: the number a numbered item was written with, null for a bullet.
   */
  | { type: 'list'; ordered: boolean; start: number; items: MdInline[][]; depths?: number[]; marks?: Array<number | null> }
  | { type: 'code'; text: string };

/* The closing run of # counts only when a space sets it off: "### C#" keeps its #. */
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const BULLET = /^([ \t]*)[-*+][ \t]+(.*)$/;
const NUMBERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
/* `[text](target)` and `![alt](target)`: shown as their text, never as a link or an image. */
const LINK = /^!?\[([^\]\n]*)\]\(([^)\n]*)\)/;
const WIKILINK = /^!?\[\[([^\]\n|]*)(?:\|([^\]\n]*))?\]\]/;
const MAX_DEPTH = 3;

/** Nesting level of a list item from its indentation: two spaces, or one tab, per level. */
function depthOf(indent: string): number {
  let width = 0;
  for (const ch of indent) width += ch === '\t' ? 2 : 1;
  return Math.min(MAX_DEPTH, Math.floor(width / 2));
}

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || ch === ' ' || ch === '\t' || ch === '\n';
}

/** Index just past the code span that opens at `i`, or -1 when it never closes. */
function codeEnd(text: string, i: number): number {
  const close = text.indexOf('`', i + 1);
  return close === -1 ? -1 : close + 1;
}

/** Index of the delimiter that closes the emphasis opened at `open`, or -1. Code spans are skipped. */
function closing(text: string, open: number, delimiter: '*' | '**'): number {
  let j = open + delimiter.length;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '`') {
      const end = codeEnd(text, j);
      if (end !== -1) {
        j = end;
        continue;
      }
    } else if (ch === '*') {
      const double = text[j + 1] === '*';
      if (delimiter === '**') {
        if (double && j > open + 2) return j;
        j += double ? 2 : 1;
        continue;
      }
      /* Inside *italic*, a ** pair is nested bold: step over it whole. */
      if (double) {
        const inner = closing(text, j, '**');
        j = inner === -1 ? j + 2 : inner + 2;
        continue;
      }
      if (!isSpace(text[j - 1])) return j;
    }
    j += 1;
  }
  return -1;
}

export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let plain = '';
  const flush = () => {
    if (plain !== '') out.push({ type: 'text', text: plain });
    plain = '';
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === '`') {
      const end = codeEnd(text, i);
      if (end !== -1 && end > i + 2) {
        flush();
        out.push({ type: 'code', text: text.slice(i + 1, end - 1) });
        i = end;
        continue;
      }
    } else if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const rest = text.slice(i);
      const wiki = WIKILINK.exec(rest);
      const link = wiki ? null : LINK.exec(rest);
      const shown = wiki ? (wiki[2] ?? wiki[1] ?? '') : link ? link[1] || link[2] || '' : null;
      if (shown !== null) {
        flush();
        out.push(...parseInline(shown.replace(/[[\]]/g, '')));
        i += (wiki ?? link)![0].length;
        continue;
      }
    } else if (ch === '*') {
      const double = text[i + 1] === '*';
      const delimiter = double ? '**' : '*';
      /* An opening mark hugs its text: "2 * 3" stays as typed. */
      if (!isSpace(text[i + delimiter.length])) {
        const close = closing(text, i, delimiter);
        if (close !== -1) {
          flush();
          const children = parseInline(text.slice(i + delimiter.length, close));
          out.push({ type: double ? 'strong' : 'em', children });
          i = close + delimiter.length;
          continue;
        }
      }
      if (double) {
        /* An unclosed ** (a bullet still streaming) is shown as typed, both stars at once. */
        plain += '**';
        i += 2;
        continue;
      }
    }

    plain += ch;
    i += 1;
  }
  flush();
  return out;
}

interface ListDraft {
  ordered: boolean;
  start: number;
  items: string[];
  depths: number[];
  marks: Array<number | null>;
}

export function parseMiniMarkdown(markdown: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  /* Held in an object because the helpers below reassign them. */
  const open: { paragraph: string[]; list: ListDraft | null; code: { mark: string; lines: string[] } | null } = {
    paragraph: [],
    list: null,
    code: null,
  };

  const flushParagraph = () => {
    if (open.paragraph.length > 0) {
      blocks.push({ type: 'paragraph', children: parseInline(open.paragraph.join(' ')) });
    }
    open.paragraph = [];
  };
  const flushList = () => {
    const list = open.list;
    if (list) {
      const block: MdBlock = { type: 'list', ordered: list.ordered, start: list.start, items: list.items.map(parseInline) };
      if (list.depths.some((d) => d > 0)) {
        block.depths = list.depths;
        block.marks = list.marks;
      }
      blocks.push(block);
    }
    open.list = null;
  };
  const addItem = (ordered: boolean, start: number, text: string, depth: number) => {
    flushParagraph();
    /* A nested item of the other kind stays in its parent's list: only a change at the top level starts a new one. */
    if (open.list && open.list.ordered !== ordered && depth === 0) flushList();
    if (!open.list) open.list = { ordered, start, items: [], depths: [], marks: [] };
    open.list.items.push(text.trim());
    open.list.depths.push(depth);
    open.list.marks.push(ordered ? start : null);
  };
  const flushCode = () => {
    if (open.code) blocks.push({ type: 'code', text: open.code.lines.join('\n') });
    open.code = null;
  };

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (open.code) {
      const mark = line.trim();
      // The closing fence: the same character, at least as long, nothing else on the line.
      if (mark.length >= open.code.mark.length && mark === open.code.mark[0].repeat(mark.length)) flushCode();
      else open.code.lines.push(line);
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      open.code = { mark: fence[1], lines: [] };
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2]) });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      addItem(false, 1, bullet[2], depthOf(bullet[1]));
      continue;
    }

    const numbered = NUMBERED.exec(line);
    if (numbered) {
      addItem(true, Number(numbered[2]), numbered[3], depthOf(numbered[1]));
      continue;
    }

    /* Any other line continues what came before: the open list item, or the paragraph. */
    const items = open.list?.items;
    if (items && items.length > 0) {
      items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`;
    } else {
      open.paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  // A block still open is one that is still streaming: show what has arrived.
  flushCode();
  return blocks;
}

function appendInline(doc: Document, parent: Node, nodes: MdInline[]): void {
  for (const node of nodes) {
    if (node.type === 'text') {
      parent.appendChild(doc.createTextNode(node.text));
    } else if (node.type === 'code') {
      const code = doc.createElement('code');
      code.appendChild(doc.createTextNode(node.text));
      parent.appendChild(code);
    } else {
      const el = doc.createElement(node.type === 'strong' ? 'strong' : 'em');
      appendInline(doc, el, node.children);
      parent.appendChild(el);
    }
  }
}

function blockNode(doc: Document, block: MdBlock): Node {
  if (block.type === 'paragraph') {
    const p = doc.createElement('p');
    appendInline(doc, p, block.children);
    return p;
  }
  if (block.type === 'heading') {
    const h = doc.createElement(`h${Math.min(6, Math.max(1, block.level))}`);
    appendInline(doc, h, block.children);
    return h;
  }
  if (block.type === 'code') {
    const pre = doc.createElement('pre');
    const code = doc.createElement('code');
    code.appendChild(doc.createTextNode(block.text));
    pre.appendChild(code);
    return pre;
  }
  return listNode(doc, block);
}

function newList(doc: Document, ordered: boolean, start: number): HTMLElement {
  const el = doc.createElement(ordered ? 'ol' : 'ul');
  if (ordered && start !== 1) el.setAttribute('start', String(start));
  return el;
}

/**
 * A list with its nested lists inside the items they hang under, as HTML has them. Indented
 * items drawn as more items of the one list would be counted with it: in a numbered list the
 * item after a nested bullet would show the wrong number, and a nested numbered item none.
 */
function listNode(doc: Document, block: Extract<MdBlock, { type: 'list' }>): Node {
  /* The list open at each level, outermost first, and the last item put in each. */
  const open: Array<{ el: HTMLElement; ordered: boolean; last: HTMLElement | null }> = [
    { el: newList(doc, block.ordered, block.start), ordered: block.ordered, last: null },
  ];
  block.items.forEach((item, index) => {
    const mark = block.marks?.[index];
    const ordered = mark === undefined ? block.ordered : mark !== null;
    /* An item hangs under the one before it, at most one level down; the first under nothing. */
    const depth = index === 0 ? 0 : Math.min(block.depths?.[index] ?? 0, open.length);
    open.length = Math.min(open.length, depth + 1);
    const parent = depth > 0 ? open[depth - 1]?.last : null;
    /* Deeper than any list open, or the other kind of list than the one open at this level. */
    if (parent && (open.length === depth || open[depth]?.ordered !== ordered)) {
      const el = newList(doc, ordered, mark ?? 1);
      parent.appendChild(el);
      open[depth] = { el, ordered, last: null };
    }
    const list = open[open.length - 1];
    const li = doc.createElement('li');
    appendInline(doc, li, item);
    list.el.appendChild(li);
    list.last = li;
  });
  return open[0].el;
}

/** Renders `markdown` into `el`, replacing what was there. Returns the cleanup that takes it out again. */
export function renderMiniMarkdown(markdown: string, el: HTMLElement): () => void {
  const doc = el.ownerDocument;
  const root = doc.createElement('div');
  root.className = 'mh-md';
  for (const block of parseMiniMarkdown(markdown)) root.appendChild(blockNode(doc, block));
  el.replaceChildren(root);
  return () => {
    if (root.parentNode === el) el.removeChild(root);
  };
}
