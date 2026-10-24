// Room handshake for a two-peer friendly, transport-agnostic.
//
//   guest -> host   join   { id, team, crest }      (repeated until answered)
//   host  -> guest  start  { seed, home, away, ... } (both build the same MatchState from it)
//   guest -> host   ready                            (guest's lockstep is listening)
//
// After `ready` both sides run Lockstep (src/net/lockstep.ts) over the same
// transport. The host is always the home side (team 0). Once paired, each
// side ignores every other sender, so a third tab on the same code just
// times out.

import type { CrestPattern } from '../meta/names.ts';
import { createMatch } from '../sim/match.ts';
import type { MatchState, TeamSetup } from '../sim/types.ts';
import type { LockstepMsg } from './lockstep.ts';

export interface StartInfo {
  seed: number;
  home: TeamSetup;
  away: TeamSetup;
  crests: [CrestPattern, CrestPattern];
  halfSeconds: number;
  /** Lockstep input delay, ticks. The host picks it so both sides agree. */
  delay: number;
}

export type RoomMsg =
  | { t: 'join'; id: string; team: TeamSetup; crest: CrestPattern }
  | { t: 'start'; to: string; host: string; start: StartInfo }
  | { t: 'ready'; id: string };

export type WireMsg = RoomMsg | LockstepMsg;

const ROOM_KINDS = new Set(['join', 'start', 'ready']);
// Null-safe: these see whatever the peer sent. Lockstep validates its own messages further.
export const isRoomMsg = (m: WireMsg): m is RoomMsg => !!m && typeof m === 'object' && ROOM_KINDS.has(m.t);
export const isLockstepMsg = (m: WireMsg): m is LockstepMsg => !!m && typeof m === 'object' && !ROOM_KINDS.has(m.t);

/** Both peers call this with the same StartInfo; the copy guarantees nothing is shared with the message. */
export function matchFromStart(st: StartInfo): MatchState {
  const c = structuredClone(st);
  return createMatch({ seed: c.seed, home: c.home, away: c.away, halfSeconds: c.halfSeconds, humans: [true, true] });
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A short room code from any 0..1 random source (the client passes Math.random; the sim never sees it). */
export function roomCode(rand: () => number, n = 4): string {
  let s = '';
  for (let i = 0; i < n; i++) s += CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)];
  return s;
}

/** Normalise what a person typed: upper case, letters and digits only. */
export function cleanCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}
