'use strict';

/* The binary frames the worker reads on stdin. The format is specified in
   protocol/segments.md; src/stt/protocol.ts holds the sender's copy of these
   constants and must stay in step with this file. */

const MAGIC = Buffer.from([0x4d, 0x48]); // "MH"
const VERSION = 1;
const SOURCE_MIC = 0;
const SOURCE_SYSTEM = 1;
const SOURCE_CONTROL = 255;
const HEADER_BYTES = 8;
const MAX_PAYLOAD = 1024 * 1024;

/**
 * @param {number} source 0..255
 * @param {Uint8Array} payload
 * @returns {Buffer}
 */
function encodeFrame(source, payload) {
  if (!Number.isInteger(source) || source < 0 || source > 255) {
    throw new RangeError(`Frame source must be 0..255, got ${source}`);
  }
  if (payload.length > MAX_PAYLOAD) {
    throw new RangeError(`Frame payload is ${payload.length} bytes, the limit is ${MAX_PAYLOAD}`);
  }
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  frame[0] = MAGIC[0];
  frame[1] = MAGIC[1];
  frame[2] = VERSION;
  frame[3] = source;
  frame.writeUInt32LE(payload.length, 4);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

function protocolError(message) {
  const err = new Error(message);
  err.code = 'protocol';
  return err;
}

/**
 * Reassembles frames from arbitrary chunks. `onFrame` receives a payload that
 * is only valid during the call. After the first error the parser goes
 * silent: once the framing is lost there is no way to find the next header.
 *
 * @param {{ onFrame(source: number, payload: Buffer): void, onError(err: Error & { code: string }): void }} handlers
 * @returns {{ push(chunk: Uint8Array): void }}
 */
function createFrameParser({ onFrame, onError }) {
  let parts = [];
  let have = 0;
  // Bytes needed before another look is worthwhile. It keeps a large frame
  // that arrives in many chunks from being concatenated once per chunk.
  let need = 1;
  let failed = false;

  function fail(message) {
    failed = true;
    parts = [];
    have = 0;
    onError(protocolError(message));
  }

  function push(chunk) {
    if (failed || chunk.length === 0) return;
    const input = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    if (have + input.length < need) {
      // Copied because the caller may reuse its buffer.
      parts.push(Buffer.from(input));
      have += input.length;
      return;
    }

    const buf = parts.length ? Buffer.concat([...parts, input], have + input.length) : input;
    parts = [];
    have = 0;

    let offset = 0;
    for (;;) {
      const avail = buf.length - offset;
      // Checked byte by byte so that garbage is reported at once, not after
      // eight bytes of it have arrived.
      if (
        (avail >= 1 && buf[offset] !== MAGIC[0]) ||
        (avail >= 2 && buf[offset + 1] !== MAGIC[1])
      ) {
        return fail('Bad frame magic');
      }
      if (avail >= 3 && buf[offset + 2] !== VERSION) {
        return fail(`Unsupported frame version ${buf[offset + 2]}`);
      }
      if (avail < HEADER_BYTES) {
        need = avail + 1;
        break;
      }
      const size = buf.readUInt32LE(offset + 4);
      if (size > MAX_PAYLOAD) {
        return fail(`Frame payload of ${size} bytes exceeds the ${MAX_PAYLOAD} byte limit`);
      }
      if (avail < HEADER_BYTES + size) {
        need = HEADER_BYTES + size;
        break;
      }
      const start = offset + HEADER_BYTES;
      onFrame(buf[offset + 3], buf.subarray(start, start + size));
      offset = start + size;
    }

    if (offset < buf.length) {
      parts = [Buffer.from(buf.subarray(offset))];
      have = buf.length - offset;
    }
  }

  return { push };
}

module.exports = {
  MAGIC,
  VERSION,
  SOURCE_MIC,
  SOURCE_SYSTEM,
  SOURCE_CONTROL,
  HEADER_BYTES,
  MAX_PAYLOAD,
  encodeFrame,
  createFrameParser,
};
