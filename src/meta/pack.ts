// A small lossless byte compressor for replay codes: an adaptive binary range coder (the scheme
// LZMA uses for its literals) with an order-1 context, so each byte is predicted from the one before
// it. Replay inputs are already run-length and delta coded (replay.ts writeRuns); what is left is a
// stream of flag bytes and small deltas that this squeezes to roughly half or less. Pure and
// synchronous: no DOM, no CompressionStream, the same bytes back on every engine.

const TOP = 2 ** 24;
const BITS = 11;
const ONE = 1 << BITS;
const MOVE = 5;

/** Compress bytes. */
export function pack(data: Uint8Array): Uint8Array {
  const probs = new Uint16Array(256 * 256).fill(ONE >> 1);
  const out: number[] = [];
  let low = 0; // up to 2^40, kept in a double
  let range = 0xffffffff;
  let cache = 0;
  let cacheSize = 1;
  const shiftLow = () => {
    if (low < 0xff000000 || low >= 2 ** 32) {
      const carry = low >= 2 ** 32 ? 1 : 0;
      let temp = cache;
      do {
        out.push((temp + carry) & 0xff);
        temp = 0xff;
      } while (--cacheSize !== 0);
      cache = Math.floor(low / TOP) & 0xff;
    }
    cacheSize++;
    low = (low % TOP) * 256;
  };
  const bit = (i: number, b: number) => {
    const p = probs[i];
    const bound = (range >>> BITS) * p;
    if (b === 0) {
      range = bound;
      probs[i] = p + ((ONE - p) >> MOVE);
    } else {
      low += bound;
      range -= bound;
      probs[i] = p - (p >> MOVE);
    }
    while (range < TOP) {
      range = (range * 256) >>> 0;
      shiftLow();
    }
  };
  let ctx = 0;
  for (const byte of data) {
    let node = 1;
    for (let k = 7; k >= 0; k--) {
      const b = (byte >> k) & 1;
      bit(ctx * 256 + node, b);
      node = node * 2 + b;
    }
    ctx = byte;
  }
  for (let i = 0; i < 5; i++) shiftLow();
  return Uint8Array.from(out);
}

/** Decompress `length` bytes packed by pack(). Throws on data that runs out. */
export function unpack(data: Uint8Array, length: number): Uint8Array {
  const probs = new Uint16Array(256 * 256).fill(ONE >> 1);
  const out = new Uint8Array(length);
  let pos = 0;
  const next = () => {
    if (pos >= data.length) throw new Error('packed data cut short');
    return data[pos++];
  };
  let range = 0xffffffff;
  let code = 0;
  for (let i = 0; i < 5; i++) code = ((code * 256) >>> 0) + next();
  code >>>= 0;
  const bit = (i: number): number => {
    const p = probs[i];
    const bound = (range >>> BITS) * p;
    let b: number;
    if (code < bound) {
      range = bound;
      probs[i] = p + ((ONE - p) >> MOVE);
      b = 0;
    } else {
      code -= bound;
      range -= bound;
      probs[i] = p - (p >> MOVE);
      b = 1;
    }
    while (range < TOP) {
      range = (range * 256) >>> 0;
      code = (((code * 256) >>> 0) + next()) >>> 0;
    }
    return b;
  };
  let ctx = 0;
  for (let n = 0; n < length; n++) {
    let node = 1;
    for (let k = 0; k < 8; k++) node = node * 2 + bit(ctx * 256 + node);
    const byte = node & 0xff;
    out[n] = byte;
    ctx = byte;
  }
  return out;
}
