// Wire protocol between a browser and the relay (server/relay-core.ts). JSON
// text frames, one object each, discriminated by `t`. Shared by the relay and
// the client transport (src/net/websocket.ts) so the two cannot drift.
//
//   client -> relay                         relay -> client
//   host   { v }                            hosted  { code, seat: 0, token }
//   join   { code, v }                      joined  { code, seat: 1, token }   (peer gets peer { s: 'joined' })
//   resume { code, seat, token }            resumed { code, seat, peer }       (peer gets peer { s: 'back' })
//   relay  { m }   (forwarded verbatim)     relay   { m }
//   ping   { n }                            pong    { n }
//   leave  {}                               peer    { s: 'away' | 'back' | 'joined' | 'left', why? }
//                                           error   { code, msg }              (fatal ones are followed by a close)
//
// The relay never looks inside `m` beyond the frame size cap: the lockstep
// inputs and room handshake (src/net/room.ts) are opaque to it.

/** Bumped when this protocol changes shape. Part of the version a room is pinned to. */
export const PROTOCOL = 1;

export type ClientMsg =
  | { t: 'host'; v: string }
  | { t: 'join'; code: string; v: string }
  | { t: 'resume'; code: string; seat: 0 | 1; token: string }
  | { t: 'relay'; m: unknown }
  | { t: 'ping'; n: number }
  | { t: 'leave' };

export type PeerState = 'joined' | 'away' | 'back' | 'left';

export type ErrorCode =
  /** No room with that code (never existed, expired, or both players left). */
  | 'no-room'
  /** The room already has two players. */
  | 'full'
  /** The other player runs a different build of the game. */
  | 'version'
  /** Seat token did not match, or the seat's grace window is over. */
  | 'bad-token'
  /** The relay is at its room or connection limit. */
  | 'busy'
  /** Too many messages too fast. */
  | 'rate'
  /** A frame over the size cap. */
  | 'too-big'
  /** Not JSON, unknown type, or a message out of order (e.g. relay before host/join). */
  | 'bad-msg'
  /** No host/join in time, no message in time, or the room's lifetime is over. */
  | 'timeout';

export type ServerMsg =
  | { t: 'hosted'; code: string; seat: 0; token: string }
  | { t: 'joined'; code: string; seat: 1; token: string }
  | { t: 'resumed'; code: string; seat: 0 | 1; peer: boolean }
  | { t: 'relay'; m: unknown }
  | { t: 'pong'; n: number }
  | { t: 'peer'; s: PeerState; why?: string }
  | { t: 'error'; code: ErrorCode; msg: string };

/** WebSocket close codes the relay uses (4000-4999 is the application range). */
export const CLOSE = {
  normal: 1000,
  policy: 1008,
  tooBig: 1009,
  error: 4000,
} as const;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Room codes: 5 characters from a 32-letter alphabet with no 0/O or 1/I (33.5 million codes). */
export const CODE_LENGTH = 5;
export const CODE_RE = new RegExp(`^[${CODE_CHARS}]{${CODE_LENGTH}}$`);

export function makeCode(rand: () => number): string {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)];
  return s;
}
