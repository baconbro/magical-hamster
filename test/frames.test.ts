import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  EXIT,
  FRAME_VERSION,
  HEADER_BYTES,
  MAX_PAYLOAD,
  SOURCE_CONTROL,
  SOURCE_MIC,
  SOURCE_SYSTEM,
  createLineSplitter,
  encodeControl,
  encodeFrame,
  encodePcm,
  floatToInt16,
  parseEventLine,
  sourceByte,
} from '../src/stt/protocol.ts';

interface FramesModule {
  MAGIC: Uint8Array;
  VERSION: number;
  SOURCE_MIC: number;
  SOURCE_SYSTEM: number;
  SOURCE_CONTROL: number;
  HEADER_BYTES: number;
  MAX_PAYLOAD: number;
  encodeFrame(source: number, payload: Uint8Array): Uint8Array;
  createFrameParser(handlers: {
    onFrame(source: number, payload: Uint8Array): void;
    onError(err: Error & { code?: string }): void;
  }): { push(chunk: Uint8Array): void };
}

const require = createRequire(import.meta.url);
const frames = require('../stt/frames.cjs') as FramesModule;

interface Seen {
  source: number;
  payload: number[];
}

function collector() {
  const seen: Seen[] = [];
  const errors: Array<Error & { code?: string }> = [];
  const parser = frames.createFrameParser({
    // Copied: the parser only lends the payload for the duration of the call.
    onFrame: (source, payload) => seen.push({ source, payload: [...payload] }),
    onError: (err) => errors.push(err),
  });
  return { seen, errors, parser };
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const hello = { type: 'hello', source: 'mic', sampleRate: 48000 };
const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 0x0102]);

function sampleStream(): { bytes: Uint8Array; expected: Seen[] } {
  const control = encodeControl(hello);
  const audio = encodePcm(SOURCE_MIC, pcm);
  const empty = encodeFrame(SOURCE_SYSTEM, new Uint8Array(0));
  const bye = encodeControl({ type: 'bye' });
  return {
    bytes: concat(control, audio, empty, bye),
    expected: [control, audio, empty, bye].map((frame) => ({
      source: frame[3],
      payload: [...frame.subarray(HEADER_BYTES)],
    })),
  };
}

test('both sides agree on the constants', () => {
  assert.deepEqual([...frames.MAGIC], [0x4d, 0x48]);
  assert.equal(frames.VERSION, FRAME_VERSION);
  assert.equal(frames.SOURCE_MIC, SOURCE_MIC);
  assert.equal(frames.SOURCE_SYSTEM, SOURCE_SYSTEM);
  assert.equal(frames.SOURCE_CONTROL, SOURCE_CONTROL);
  assert.equal(frames.HEADER_BYTES, HEADER_BYTES);
  assert.equal(frames.MAX_PAYLOAD, MAX_PAYLOAD);
  assert.equal(MAX_PAYLOAD, 1024 * 1024);
  assert.deepEqual(EXIT, { ok: 0, error: 1, modelMissing: 2, addonLoadFailed: 3, protocol: 4 });
  assert.equal(sourceByte('mic'), 0);
  assert.equal(sourceByte('system'), 1);
});

test('the header is M H, version, source, then the payload size little-endian', () => {
  const frame = encodeFrame(SOURCE_SYSTEM, Uint8Array.from([9, 8, 7]));
  assert.deepEqual([...frame], [0x4d, 0x48, 1, 1, 3, 0, 0, 0, 9, 8, 7]);
  const big = encodeFrame(SOURCE_MIC, new Uint8Array(0x010203));
  assert.deepEqual([...big.subarray(0, HEADER_BYTES)], [0x4d, 0x48, 1, 0, 0x03, 0x02, 0x01, 0]);
});

test('the TypeScript and the CommonJS encoders write the same bytes', () => {
  const payload = Uint8Array.from([1, 2, 3, 4, 5]);
  for (const source of [SOURCE_MIC, SOURCE_SYSTEM, SOURCE_CONTROL]) {
    assert.deepEqual([...frames.encodeFrame(source, payload)], [...encodeFrame(source, payload)]);
  }
});

test('frames round-trip from the protocol encoders to the worker parser', () => {
  const { bytes, expected } = sampleStream();
  const { seen, errors, parser } = collector();
  parser.push(bytes);
  assert.deepEqual(errors, []);
  assert.deepEqual(seen, expected);
  assert.equal(seen[0].source, SOURCE_CONTROL);
  assert.deepEqual(JSON.parse(Buffer.from(seen[0].payload).toString('utf8')), hello);
  assert.equal(seen[1].source, SOURCE_MIC);
  assert.equal(seen[2].payload.length, 0);
});

test('a stream split at every byte position yields the same frames', () => {
  const { bytes, expected } = sampleStream();
  for (let cut = 1; cut < bytes.length; cut++) {
    const { seen, errors, parser } = collector();
    parser.push(bytes.subarray(0, cut));
    parser.push(bytes.subarray(cut));
    assert.deepEqual(errors, [], `split at ${cut}`);
    assert.deepEqual(seen, expected, `split at ${cut}`);
  }
});

test('a stream fed one byte at a time yields the same frames', () => {
  const { bytes, expected } = sampleStream();
  const { seen, errors, parser } = collector();
  for (let i = 0; i < bytes.length; i++) parser.push(bytes.subarray(i, i + 1));
  assert.deepEqual(errors, []);
  assert.deepEqual(seen, expected);
});

test('several frames in one chunk, and a frame spread over many chunks', () => {
  const { seen, errors, parser } = collector();
  const many = concat(...Array.from({ length: 50 }, (_, i) => encodePcm(SOURCE_MIC, Int16Array.from([i, -i]))));
  parser.push(many);
  assert.equal(seen.length, 50);
  assert.deepEqual(seen[49].payload, [49, 0, 0xcf, 0xff]);

  const payload = new Uint8Array(MAX_PAYLOAD);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  const large = encodeFrame(SOURCE_SYSTEM, payload);
  for (let offset = 0; offset < large.length; offset += 65536) {
    parser.push(large.subarray(offset, offset + 65536));
  }
  assert.deepEqual(errors, []);
  assert.equal(seen.length, 51);
  assert.equal(seen[50].source, SOURCE_SYSTEM);
  assert.equal(seen[50].payload.length, MAX_PAYLOAD);
  assert.ok(seen[50].payload.every((byte, i) => byte === i % 251));
});

test('the parser keeps its own copy of an unfinished frame', () => {
  const { seen, parser } = collector();
  const frame = encodePcm(SOURCE_MIC, Int16Array.from([100, 200, 300]));
  const reused = new Uint8Array(5);
  reused.set(frame.subarray(0, 5));
  parser.push(reused);
  reused.fill(0xee);
  parser.push(frame.subarray(5));
  assert.deepEqual(seen, [{ source: SOURCE_MIC, payload: [100, 0, 200, 0, 0x2c, 0x01] }]);
});

test('bad magic is a protocol error, and the parser then ignores input', () => {
  const { seen, errors, parser } = collector();
  parser.push(Uint8Array.from([0x47, 0x45, 0x54, 0x20, 0x2f, 0x20, 0x48, 0x54]));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'protocol');
  assert.match(errors[0].message, /magic/i);
  parser.push(encodeControl({ type: 'bye' }));
  parser.push(Uint8Array.from([1, 2, 3]));
  assert.equal(errors.length, 1);
  assert.deepEqual(seen, []);
});

test('garbage is reported from its first byte', () => {
  const first = collector();
  first.parser.push(Uint8Array.from([0x00]));
  assert.equal(first.errors.length, 1);

  const second = collector();
  second.parser.push(Uint8Array.from([0x4d]));
  assert.equal(second.errors.length, 0);
  second.parser.push(Uint8Array.from([0x00]));
  assert.equal(second.errors.length, 1);
  assert.equal(second.errors[0].code, 'protocol');
});

test('frames before a bad one are delivered', () => {
  const { seen, errors, parser } = collector();
  const good = encodePcm(SOURCE_MIC, Int16Array.from([7]));
  parser.push(concat(good, Uint8Array.from([0xde, 0xad, 0xbe, 0xef]), good));
  assert.equal(seen.length, 1);
  assert.equal(errors.length, 1);
});

test('an unknown version is a protocol error', () => {
  const { seen, errors, parser } = collector();
  const frame = encodeControl({ type: 'flush' });
  frame[2] = 2;
  parser.push(frame);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'protocol');
  assert.match(errors[0].message, /version 2/);
  assert.deepEqual(seen, []);
});

test('an oversized payload is a protocol error on both sides', () => {
  const { seen, errors, parser } = collector();
  const header = new Uint8Array(HEADER_BYTES);
  header.set([0x4d, 0x48, 1, 0]);
  new DataView(header.buffer).setUint32(4, MAX_PAYLOAD + 1, true);
  parser.push(header);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'protocol');
  assert.deepEqual(seen, []);

  assert.throws(() => encodeFrame(SOURCE_MIC, new Uint8Array(MAX_PAYLOAD + 1)), RangeError);
  assert.throws(() => frames.encodeFrame(SOURCE_MIC, new Uint8Array(MAX_PAYLOAD + 1)), RangeError);
  assert.throws(() => encodeFrame(256, new Uint8Array(1)), RangeError);
  assert.throws(() => frames.encodeFrame(-1, new Uint8Array(1)), RangeError);
  // Exactly the limit is allowed.
  assert.equal(encodeFrame(SOURCE_MIC, new Uint8Array(MAX_PAYLOAD)).length, HEADER_BYTES + MAX_PAYLOAD);
});

test('encodePcm writes little-endian samples whatever the platform', () => {
  const frame = encodePcm(SOURCE_SYSTEM, Int16Array.from([0x0102, -2, 1]));
  assert.equal(frame[3], SOURCE_SYSTEM);
  assert.deepEqual([...frame.subarray(4, 8)], [6, 0, 0, 0]);
  assert.deepEqual([...frame.subarray(HEADER_BYTES)], [0x02, 0x01, 0xfe, 0xff, 0x01, 0x00]);
  // A view into a larger buffer is encoded from its own offset.
  const backing = Int16Array.from([9, 9, 0x0304, 9]);
  const view = backing.subarray(2, 3);
  assert.deepEqual([...encodePcm(SOURCE_MIC, view).subarray(HEADER_BYTES)], [0x04, 0x03]);
});

test('encodeControl writes UTF-8 JSON on the control source', () => {
  const message = { type: 'hello', source: 'system', sampleRate: 44100, note: 'réunion' };
  const frame = encodeControl(message);
  assert.equal(frame[3], SOURCE_CONTROL);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(frame.subarray(HEADER_BYTES))), message);
});

test('floatToInt16 scales and clamps', () => {
  const out = floatToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5, -0.5, NaN, Infinity, -Infinity]));
  assert.deepEqual([...out], [0, 32767, -32768, 32767, -32768, 16384, -16384, 0, 32767, -32768]);
});

test('parseEventLine keeps the closing mark of a final, and only a mark', () => {
  const line = (extra: string) => `{"type":"segment","source":"mic","t0":1,"t1":2,"text":"Sure","isFinal":true${extra}}`;
  assert.equal((parseEventLine(line(',"closes":"?"')) as { closes?: string }).closes, '?');
  assert.equal('closes' in (parseEventLine(line(',"closes":"nope"')) as object), false);
  assert.equal(
    'closes' in (parseEventLine('{"type":"segment","source":"mic","t0":1,"t1":2,"text":"Sure","isFinal":false,"closes":"?"}') as object),
    false,
    'a partial does not close anything',
  );
});

test('parseEventLine reads every event type', () => {
  assert.deepEqual(parseEventLine('{"type":"ready","model":"fake","chunkMs":560}'), {
    type: 'ready',
    model: 'fake',
    chunkMs: 560,
  });
  assert.deepEqual(
    parseEventLine(
      '{"type":"segment","source":"mic","t0":12.34,"t1":14.02,"text":"on se revoit jeudi","isFinal":false,"lang":"fr","langSource":"heuristic"}',
    ),
    {
      type: 'segment',
      source: 'mic',
      t0: 12.34,
      t1: 14.02,
      text: 'on se revoit jeudi',
      isFinal: false,
      lang: 'fr',
      langSource: 'heuristic',
    },
  );
  assert.deepEqual(parseEventLine('{"type":"segment","source":"system","t0":0,"t1":0.5,"text":"","isFinal":true}'), {
    type: 'segment',
    source: 'system',
    t0: 0,
    t1: 0.5,
    text: '',
    isFinal: true,
  });
  assert.deepEqual(parseEventLine('{"type":"stats","rtf":0.15,"backlogMs":120}'), {
    type: 'stats',
    rtf: 0.15,
    backlogMs: 120,
  });
  assert.deepEqual(parseEventLine('{"type":"error","code":"model_missing","message":"no model"}'), {
    type: 'error',
    code: 'model_missing',
    message: 'no model',
  });
  assert.deepEqual(parseEventLine('{"type":"error","code":"internal"}'), { type: 'error', code: 'internal' });
  // Surrounding whitespace and a carriage return are tolerated.
  assert.deepEqual(parseEventLine('  {"type":"stats","rtf":0,"backlogMs":0}\r'), {
    type: 'stats',
    rtf: 0,
    backlogMs: 0,
  });
});

test('parseEventLine keeps only what the contract names', () => {
  assert.deepEqual(parseEventLine('{"type":"ready","model":"m","chunkMs":80,"extra":true}'), {
    type: 'ready',
    model: 'm',
    chunkMs: 80,
  });
  // An unknown language is dropped; the segment survives.
  assert.deepEqual(
    parseEventLine('{"type":"segment","source":"mic","t0":1,"t1":2,"text":"hallo","isFinal":true,"lang":"de","langSource":"heuristic"}'),
    { type: 'segment', source: 'mic', t0: 1, t1: 2, text: 'hallo', isFinal: true },
  );
  assert.deepEqual(
    parseEventLine('{"type":"segment","source":"mic","t0":1,"t1":2,"text":"hello","isFinal":true,"lang":"en","langSource":"model"}'),
    { type: 'segment', source: 'mic', t0: 1, t1: 2, text: 'hello', isFinal: true, lang: 'en' },
  );
});

test('parseEventLine returns null for blank lines and for anything malformed', () => {
  const rejected = [
    '',
    '   ',
    '\r',
    'not json',
    '{',
    '{"type":"ready"',
    'null',
    '42',
    '"ready"',
    '[]',
    '[{"type":"stats","rtf":0,"backlogMs":0}]',
    '{}',
    '{"type":"unknown"}',
    '{"type":"selftest","ok":true,"finals":1,"seconds":2,"rtf":0.1}',
    '{"type":"ready","model":"m"}',
    '{"type":"ready","model":7,"chunkMs":560}',
    '{"type":"ready","model":"m","chunkMs":"560"}',
    '{"type":"segment"}',
    '{"type":"segment","source":"speaker","t0":0,"t1":1,"text":"x","isFinal":true}',
    '{"type":"segment","source":"mic","t0":"0","t1":1,"text":"x","isFinal":true}',
    '{"type":"segment","source":"mic","t0":0,"t1":null,"text":"x","isFinal":true}',
    '{"type":"segment","source":"mic","t0":0,"t1":1,"text":5,"isFinal":true}',
    '{"type":"segment","source":"mic","t0":0,"t1":1,"text":"x","isFinal":"yes"}',
    '{"type":"segment","source":"mic","t0":0,"t1":1,"text":"x"}',
    '{"type":"stats","rtf":0.1}',
    '{"type":"stats","rtf":"fast","backlogMs":0}',
    '{"type":"error"}',
    '{"type":"error","code":""}',
    '{"type":"error","code":4}',
    'Unsupported language \'xx\' for multilingual NeMo transducer; using auto',
  ];
  for (const line of rejected) assert.equal(parseEventLine(line), null, line);
});

test('the line splitter handles several lines per chunk and lines across chunks', () => {
  const lines: string[] = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.push('one\ntwo\nthr');
  assert.deepEqual(lines, ['one', 'two']);
  splitter.push('ee\n\nfour\r\nfi');
  assert.deepEqual(lines, ['one', 'two', 'three', '', 'four']);
  splitter.push('ve');
  assert.deepEqual(lines.length, 5);
  splitter.end();
  assert.deepEqual(lines, ['one', 'two', 'three', '', 'four', 'five']);
  splitter.end();
  assert.equal(lines.length, 6);
});

test('the line splitter reassembles UTF-8 split between chunks', () => {
  const text = '{"text":"déjà réglé, 20 € à Noël"}\n{"text":"ça va"}\n';
  const bytes = new TextEncoder().encode(text);
  const expected = ['{"text":"déjà réglé, 20 € à Noël"}', '{"text":"ça va"}'];
  for (let cut = 1; cut < bytes.length; cut++) {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push(bytes.subarray(0, cut));
    splitter.push(bytes.subarray(cut));
    splitter.end();
    assert.deepEqual(lines, expected, `split at byte ${cut}`);
  }
  const lines: string[] = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  for (let i = 0; i < bytes.length; i++) splitter.push(bytes.subarray(i, i + 1));
  assert.deepEqual(lines, expected);
});

test('the line splitter accepts strings and bytes, and feeds parseEventLine', () => {
  const events: unknown[] = [];
  const splitter = createLineSplitter((line) => {
    const event = parseEventLine(line);
    if (event) events.push(event);
  });
  splitter.push('{"type":"ready","model":"fake","chu');
  splitter.push(new TextEncoder().encode('nkMs":100}\nnoise from a library\n{"type":"stats","rtf":0.1,'));
  splitter.push('"backlogMs":0}\n');
  assert.deepEqual(events, [
    { type: 'ready', model: 'fake', chunkMs: 100 },
    { type: 'stats', rtf: 0.1, backlogMs: 0 },
  ]);
});

test('the line splitter drops a runaway line instead of growing without bound', () => {
  const lines: string[] = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  const blob = 'x'.repeat(300 * 1024);
  for (let i = 0; i < 5; i++) splitter.push(blob);
  splitter.push('\n{"type":"stats","rtf":0,"backlogMs":0}\n');
  assert.equal(lines[lines.length - 1], '{"type":"stats","rtf":0,"backlogMs":0}');
  assert.ok(lines.every((line) => line.length <= 1024 * 1024));
});

test('the line splitter stays in step when its listener throws', () => {
  const lines: string[] = [];
  const splitter = createLineSplitter((line) => {
    if (line === 'boom') throw new Error('listener bug');
    lines.push(line);
  });
  splitter.push('un\ndeu');
  assert.throws(() => splitter.push('x\nboom\ntrois\nqua'), /listener bug/);
  // Nothing after the bad line is lost, and nothing before it comes twice.
  splitter.push('tre\ncinq\n');
  assert.deepEqual(lines, ['un', 'deux', 'trois', 'quatre', 'cinq']);
});
