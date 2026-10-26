import { expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { backupJson, parseBackup } from '../src/client/backup.ts';
import { newGame } from '../src/meta/game.ts';

const EXPANDED_LIMIT = 20_000_000;
const TOO_BIG = { ok: false, reason: 'That is too big to be a Derby Day backup.' };
const code = (text: string): string => `DD1.${gzipSync(text).toString('base64url')}`;

// JSON permits trailing ASCII whitespace; padding the wrapper lets us exercise
// the real gzip boundary with an otherwise valid club rather than invalid data.
test('a compressed backup exactly at the expanded byte limit still imports', async () => {
  const save = newGame(7);
  const json = backupJson(save);
  const text = json + ' '.repeat(EXPANDED_LIMIT - Buffer.byteLength(json));
  const result = await parseBackup(code(text));
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.save).toEqual(JSON.parse(JSON.stringify(save)));
});

test('a small code expanding one byte over the limit is rejected as too big', async () => {
  const json = backupJson(newGame(8));
  const text = json + ' '.repeat(EXPANDED_LIMIT + 1 - Buffer.byteLength(json));
  const compressed = code(text);
  expect(compressed.length).toBeLessThan(100_000);
  expect(await parseBackup(compressed)).toEqual(TOO_BIG);
});

test('the expanded limit counts UTF-8 bytes, not JavaScript characters', async () => {
  // Padding lives outside the save; valid wrapper metadata is ignored on import.
  const wrapper = JSON.parse(backupJson(newGame(9)));
  wrapper.padding = 'é'.repeat(EXPANDED_LIMIT / 2);
  const json = JSON.stringify(wrapper);
  expect(json.length).toBeLessThan(EXPANDED_LIMIT);
  expect(Buffer.byteLength(json)).toBeGreaterThan(EXPANDED_LIMIT);
  expect(await parseBackup(code(json))).toEqual(TOO_BIG);
});

test('a truncated gzip is rejected as damaged rather than hanging or importing partial JSON', async () => {
  const gz = gzipSync(backupJson(newGame(10)));
  // Remove only the trailer: all JSON can have been emitted before gzip reports
  // this error, so the reader must wait for successful stream completion.
  const truncated = `DD1.${gz.subarray(0, gz.length - 8).toString('base64url')}`;
  expect(await parseBackup(truncated)).toEqual({ ok: false, reason: 'That code is damaged or incomplete. Copy it again in full.' });
});

test('overflow cancels the output stream without draining the remaining chunks', async () => {
  const Original = globalThis.DecompressionStream;
  let cancelled = false;
  let pulls = 0;
  const chunk = new Uint8Array(1_000_000);
  try {
    globalThis.DecompressionStream = class {
      readable = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(chunk);
          // An unbounded producer: reading until EOF would never complete.
        },
        cancel() {
          cancelled = true;
        },
      });
      writable = new WritableStream<Uint8Array>();
    } as typeof DecompressionStream;
    expect(await parseBackup('DD1.AA')).toEqual(TOO_BIG);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(22); // one queued chunk of backpressure
  } finally {
    globalThis.DecompressionStream = Original;
  }
});
