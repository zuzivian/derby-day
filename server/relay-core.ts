// The relay as a pure state machine: rooms of two seats, envelopes forwarded
// between them, and every limit a public server needs. No sockets, no timers,
// no clock of its own: an adapter (server/bun.ts, server/cloudflare.ts) feeds
// it open / message / close events, calls sweep() about once a second, and
// passes in the clock and random sources. tests/relay.test.ts drives it with
// fake sockets and a fake clock.
//
// The relay is deliberately dumb about the game. It pairs two sockets under a
// room code, checks that both run the same build (the version string sent in
// host/join), and forwards `relay` envelopes verbatim. It never parses the
// inputs inside them, so it cannot cheat for anyone, and a client cannot use
// it to reach anything but its own opponent.
//
// Seats survive a dropped socket for `graceMs`: the client reconnects and
// sends `resume` with the seat token it got from hosted/joined, and the room
// carries on. The survivor hears `peer away` straight away and `peer back` or
// `peer left` later.

import { CLOSE, CODE_RE, makeCode, type ClientMsg, type ErrorCode, type PeerState, type ServerMsg } from '../src/net/relay.ts';

/** Whatever the adapter wraps a socket in. Identity matters: the same object for the socket's whole life. */
export interface RelaySocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface RelayLimits {
  /** Largest frame accepted, bytes. A room start with two full squads is about 4.5 KB; a worst-case lockstep batch (120 unacknowledged inputs) about 17 KB. */
  maxFrameBytes: number;
  maxRooms: number;
  maxSockets: number;
  /** Open sockets per client address (0 = no limit). Stops one machine from filling the relay. */
  maxSocketsPerIp: number;
  /** Token bucket per socket: sustained messages per second, and the burst on top. Lockstep sends about 65/s. */
  ratePerSec: number;
  burst: number;
  /** A new socket must host, join or resume within this. */
  helloMs: number;
  /** A socket that sends nothing (not even a ping) for this long is dropped. Clients ping every 5 s. */
  heartbeatMs: number;
  /** A dropped seat can be resumed for this long before the opponent is told the player left. */
  graceMs: number;
  /** A hosted room nobody joins expires after this. */
  waitingMs: number;
  /** A full room in which nobody relays anything for this long is closed. */
  idleMs: number;
  /** Hard cap on a room's life, however busy. */
  roomTtlMs: number;
  /** Joins to codes that don't exist before the socket is closed (slows down code guessing). */
  maxBadJoins: number;
  /** Failed joins and resumes per client address within `badJoinWindowMs` before that address is refused (0 = no limit). */
  maxBadJoinsPerIp: number;
  badJoinWindowMs: number;
  /** Byte budget per socket on top of the message rate: sustained bytes per second, and the burst. */
  bytesPerSec: number;
  byteBurst: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  maxFrameBytes: 32 * 1024,
  maxRooms: 2000,
  maxSockets: 5000,
  maxSocketsPerIp: 8,
  ratePerSec: 150,
  burst: 300,
  helloMs: 10_000,
  heartbeatMs: 30_000,
  graceMs: 30_000,
  waitingMs: 30 * 60_000,
  idleMs: 2 * 60_000,
  roomTtlMs: 2 * 3600_000,
  maxBadJoins: 5,
  maxBadJoinsPerIp: 30,
  badJoinWindowMs: 10 * 60_000,
  bytesPerSec: 96 * 1024,
  byteBurst: 512 * 1024,
};

export interface RelayOptions {
  /** Milliseconds clock. */
  now: () => number;
  /** 0..1 random source for room codes. */
  random: () => number;
  /** An unguessable seat token (the Bun adapter uses crypto.randomUUID). */
  token: () => string;
  limits?: Partial<RelayLimits>;
  /** Optional event log (room opened, closed, why). Never sees message contents. */
  log?: (event: string, data: Record<string, unknown>) => void;
}

interface Conn {
  sock: RelaySocket;
  ip: string;
  openedAt: number;
  lastAt: number;
  tokens: number;
  refillAt: number;
  badJoins: number;
  bytes: number;
  room: Room | null;
  seat: 0 | 1;
}

interface Seat {
  token: string;
  conn: Conn | null;
  /** When the socket dropped; null while connected. */
  awaySince: number | null;
  /** Gone for good: left, or the grace window ran out. */
  left: boolean;
}

interface Room {
  code: string;
  v: string;
  createdAt: number;
  /** Last relayed envelope, from either seat. */
  lastAt: number;
  seats: [Seat, Seat | null];
}

export interface RelayStats {
  rooms: number;
  sockets: number;
  /** Rooms with both seats taken. */
  matches: number;
  /** Envelopes forwarded since start. */
  relayed: number;
}

const MAX_VERSION_CHARS = 64;

/**
 * Who the guess limit counts against: the address, or for IPv6 its /64 (one household or phone gets a
 * whole /64, so counting single IPv6 addresses would let one machine rotate through billions of them).
 */
export function guessKey(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4) return v4[1];
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...new Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export class RelayCore {
  readonly limits: RelayLimits;
  private conns = new Map<RelaySocket, Conn>();
  private rooms = new Map<string, Room>();
  private perIp = new Map<string, number>();
  /** Failed joins and resumes per address: count and when its window started. Reconnecting doesn't reset it. */
  private badByIp = new Map<string, { n: number; since: number }>();
  private relayed = 0;

  constructor(private o: RelayOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
  }

  stats(): RelayStats {
    let matches = 0;
    for (const r of this.rooms.values()) if (r.seats[1]) matches++;
    return { rooms: this.rooms.size, sockets: this.conns.size, matches, relayed: this.relayed };
  }

  /** A socket connected. Returns false (and closes it) when the relay is full. */
  open(sock: RelaySocket, ip = ''): boolean {
    const L = this.limits;
    const ipCount = this.perIp.get(ip) ?? 0;
    if (this.conns.size >= L.maxSockets || (L.maxSocketsPerIp > 0 && ip && ipCount >= L.maxSocketsPerIp)) {
      this.sendTo(sock, { t: 'error', code: 'busy', msg: 'The match server is full right now. Try again in a minute.' });
      sock.close(CLOSE.policy, 'busy');
      return false;
    }
    const now = this.o.now();
    this.conns.set(sock, { sock, ip, openedAt: now, lastAt: now, tokens: L.burst, bytes: L.byteBurst, refillAt: now, badJoins: 0, room: null, seat: 0 });
    if (ip) this.perIp.set(ip, ipCount + 1);
    return true;
  }

  /** A frame arrived. `bytes` is its size on the wire (defaults to the string length). */
  message(sock: RelaySocket, data: string, bytes = data.length): void {
    const c = this.conns.get(sock);
    if (!c) return;
    const now = this.o.now();
    if (bytes > this.limits.maxFrameBytes) return this.fail(c, 'too-big', `Message over ${this.limits.maxFrameBytes} bytes.`, CLOSE.tooBig);
    if (!this.take(c, now, bytes)) return this.fail(c, 'rate', 'Too many messages.', CLOSE.policy);
    c.lastAt = now;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data);
    } catch {
      return this.fail(c, 'bad-msg', 'Not JSON.');
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return this.fail(c, 'bad-msg', 'Not a message.');
    switch (msg.t) {
      case 'ping':
        this.sendTo(sock, { t: 'pong', n: typeof msg.n === 'number' ? msg.n : 0 });
        return;
      case 'relay':
        return this.relay(c, msg.m, now);
      case 'host':
        return this.host(c, msg.v, now);
      case 'join':
        return this.join(c, msg.code, msg.v);
      case 'resume':
        return this.resume(c, msg.code, msg.seat, msg.token);
      case 'leave':
        return this.leave(c);
      default:
        return this.fail(c, 'bad-msg', 'Unknown message type.');
    }
  }

  /** The socket closed (either side). Its seat, if any, waits `graceMs` for a resume. */
  close(sock: RelaySocket): void {
    const c = this.conns.get(sock);
    if (!c) return;
    this.forget(c);
    const room = c.room;
    if (!room) return;
    const seat = room.seats[c.seat];
    if (seat && seat.conn === c) {
      seat.conn = null;
      seat.awaySince = this.o.now();
      this.notifyOther(room, c.seat, 'away');
    }
  }

  /** Expire whatever is due. Call about once a second. */
  sweep(): void {
    const now = this.o.now();
    const L = this.limits;
    for (const c of [...this.conns.values()]) {
      if (!c.room && now - c.openedAt > L.helloMs) this.fail(c, 'timeout', 'No host or join in time.');
      else if (now - c.lastAt > L.heartbeatMs) {
        // Silent but not closed (a frozen tab, a dead NAT mapping): treat it as a drop, so the seat gets its grace window.
        this.close(c.sock);
        c.sock.close(CLOSE.error, 'timeout');
      }
    }
    for (const [ip, b] of this.badByIp) if (now - b.since >= L.badJoinWindowMs) this.badByIp.delete(ip);
    for (const room of [...this.rooms.values()]) {
      for (const i of [0, 1] as const) {
        const seat = room.seats[i];
        if (seat && !seat.left && seat.awaySince !== null && now - seat.awaySince > L.graceMs) {
          seat.left = true;
          this.notifyOther(room, i, 'left', 'timeout');
        }
      }
      if (this.empty(room)) this.drop(room, 'empty');
      else if (now - room.createdAt > L.roomTtlMs) this.shut(room, 'Room time limit reached.', 'ttl');
      else if (!room.seats[1] && now - room.createdAt > L.waitingMs) this.shut(room, 'Nobody joined in time.', 'unjoined');
      else if (room.seats[1] && now - room.lastAt > L.idleMs) this.shut(room, 'Room idle for too long.', 'idle');
    }
  }

  // -------------------------------------------------------------------------

  private host(c: Conn, v: unknown, now: number): void {
    if (c.room) return this.fail(c, 'bad-msg', 'Already in a room.');
    if (typeof v !== 'string' || !v || v.length > MAX_VERSION_CHARS) return this.fail(c, 'bad-msg', 'Missing version.');
    if (this.rooms.size >= this.limits.maxRooms) return this.fail(c, 'busy', 'The match server is full right now. Try again in a minute.', CLOSE.policy);
    let code = makeCode(this.o.random);
    for (let i = 0; this.rooms.has(code); i++) {
      if (i > 50) return this.fail(c, 'busy', 'Could not find a free room code.', CLOSE.policy);
      code = makeCode(this.o.random);
    }
    const token = this.o.token();
    const room: Room = { code, v, createdAt: now, lastAt: now, seats: [{ token, conn: c, awaySince: null, left: false }, null] };
    this.rooms.set(code, room);
    c.room = room;
    c.seat = 0;
    this.sendTo(c.sock, { t: 'hosted', code, seat: 0, token });
    this.o.log?.('room-open', { code, v, rooms: this.rooms.size });
  }

  private join(c: Conn, rawCode: unknown, v: unknown): void {
    if (c.room) return this.fail(c, 'bad-msg', 'Already in a room.');
    const now = this.o.now();
    const code = typeof rawCode === 'string' ? rawCode.toUpperCase() : '';
    const room = CODE_RE.test(code) ? this.rooms.get(code) : undefined;
    if (!room || room.seats[0].left) {
      // Only wrong codes are refused for an address that has guessed too much: a right code still gets in,
      // so one guesser behind a shared address (campus or carrier NAT) can't lock everyone else out.
      if (this.guessing(c, now)) return this.fail(c, 'rate', 'Too many wrong codes from this address. Wait a few minutes, then try again.');
      const shown = CODE_RE.test(code) ? code : '?';
      const msg: ServerMsg = { t: 'error', code: 'no-room', msg: `No match with code ${shown}. Check the code, or ask your friend for a new link.` };
      this.sendTo(c.sock, msg);
      this.badGuess(c, now);
      return;
    }
    if (room.seats[1]) return this.reply(c, 'full', 'That match already has two players.');
    if (v !== room.v) return this.reply(c, 'version', 'Your friend is on a different version of Derby Day. Both of you reload the page, then try again.');
    const token = this.o.token();
    room.seats[1] = { token, conn: c, awaySince: null, left: false };
    room.lastAt = this.o.now();
    c.room = room;
    c.seat = 1;
    this.sendTo(c.sock, { t: 'joined', code, seat: 1, token });
    this.notifyOther(room, 1, 'joined');
    if (room.seats[0].awaySince !== null) this.sendTo(c.sock, { t: 'peer', s: 'away' });
    this.o.log?.('room-full', { code });
  }

  private resume(c: Conn, rawCode: unknown, seatNo: unknown, token: unknown): void {
    if (c.room) return this.fail(c, 'bad-msg', 'Already in a room.');
    const now = this.o.now();
    const room = typeof rawCode === 'string' ? this.rooms.get(rawCode.toUpperCase()) : undefined;
    const seat = room && (seatNo === 0 || seatNo === 1) ? room.seats[seatNo] : null;
    // Unknown room and wrong token get the same answer, so resume can't be used to probe which codes exist.
    // A valid resume always gets through, even from an address that has guessed too much.
    if (!room || !seat || seat.left || typeof token !== 'string' || token !== seat.token) {
      if (this.guessing(c, now)) return this.fail(c, 'rate', 'Too many failed attempts from this address. Wait a few minutes, then try again.');
      this.sendTo(c.sock, { t: 'error', code: 'bad-token', msg: 'Could not rejoin that match.' });
      if (!this.badGuess(c, now)) this.kick(c, CLOSE.normal, 'bad-token');
      return;
    }
    if (seat.conn) {
      // The old socket is still open from our side (it went quiet without closing): the new one wins.
      const old = seat.conn;
      old.room = null;
      this.kick(old, CLOSE.normal, 'replaced');
    }
    const wasAway = seat.awaySince !== null;
    seat.conn = c;
    seat.awaySince = null;
    c.room = room;
    c.seat = seatNo as 0 | 1;
    const other = room.seats[c.seat === 0 ? 1 : 0];
    this.sendTo(c.sock, { t: 'resumed', code: room.code, seat: c.seat, peer: !!other?.conn });
    if (other && !other.conn && !other.left) this.sendTo(c.sock, { t: 'peer', s: 'away' });
    if (other?.left) this.sendTo(c.sock, { t: 'peer', s: 'left', why: 'left' });
    if (wasAway) this.notifyOther(room, c.seat, 'back');
  }

  private relay(c: Conn, m: unknown, now: number): void {
    const room = c.room;
    if (!room) return this.fail(c, 'bad-msg', 'Not in a room.');
    const other = room.seats[c.seat === 0 ? 1 : 0];
    room.lastAt = now;
    // Nobody to hear it (not joined yet, or dropped): lockstep re-sends what wasn't acknowledged, so dropping is safe.
    if (!other?.conn) return;
    this.relayed++;
    this.sendTo(other.conn.sock, { t: 'relay', m });
  }

  private leave(c: Conn): void {
    const room = c.room;
    if (room) {
      const seat = room.seats[c.seat]!;
      seat.left = true;
      seat.conn = null;
      c.room = null;
      this.notifyOther(room, c.seat, 'left', 'left');
      if (this.empty(room)) this.drop(room, 'left');
    }
    this.kick(c, CLOSE.normal, 'left');
  }

  // -------------------------------------------------------------------------

  /** Token bucket. */
  private take(c: Conn, now: number, bytes: number): boolean {
    const L = this.limits;
    const dt = now - c.refillAt;
    c.tokens = Math.min(L.burst, c.tokens + (dt * L.ratePerSec) / 1000);
    c.bytes = Math.min(L.byteBurst, c.bytes + (dt * L.bytesPerSec) / 1000);
    c.refillAt = now;
    if (c.tokens < 1 || c.bytes < bytes) return false;
    c.tokens -= 1;
    c.bytes -= bytes;
    return true;
  }

  /** This address has guessed wrong too often lately. */
  private guessing(c: Conn, now: number): boolean {
    const L = this.limits;
    if (!c.ip || !L.maxBadJoinsPerIp) return false;
    const b = this.badByIp.get(guessKey(c.ip));
    return !!b && now - b.since < L.badJoinWindowMs && b.n >= L.maxBadJoinsPerIp;
  }

  /** Count a failed join or resume against the socket and its address. Returns true when the socket was closed. */
  private badGuess(c: Conn, now: number): boolean {
    c.badJoins++;
    if (c.ip) {
      const key = guessKey(c.ip);
      const b = this.badByIp.get(key);
      if (!b || now - b.since >= this.limits.badJoinWindowMs) this.badByIp.set(key, { n: 1, since: now });
      else b.n++;
    }
    if (c.badJoins >= this.limits.maxBadJoins) {
      this.kick(c, CLOSE.policy, 'too many bad joins');
      return true;
    }
    return false;
  }

  /** Every seat gone for good (or never taken)? */
  private empty(room: Room): boolean {
    return room.seats.every((s) => !s || s.left);
  }

  private notifyOther(room: Room, from: 0 | 1, s: PeerState, why?: string): void {
    const other = room.seats[from === 0 ? 1 : 0];
    if (other?.conn) this.sendTo(other.conn.sock, why ? { t: 'peer', s, why } : { t: 'peer', s });
  }

  /** Close a room on the relay's own initiative: tell whoever is connected, then drop it. */
  private shut(room: Room, msg: string, why: string): void {
    for (const seat of room.seats) {
      const c = seat?.conn;
      if (!c) continue;
      c.room = null;
      this.sendTo(c.sock, { t: 'error', code: 'timeout', msg });
      this.kick(c, CLOSE.normal, why);
    }
    this.drop(room, why);
  }

  private drop(room: Room, why: string): void {
    if (this.rooms.get(room.code) !== room) return;
    this.rooms.delete(room.code);
    this.o.log?.('room-close', { code: room.code, why, rooms: this.rooms.size });
  }

  /** A non-fatal refusal: say why and close politely (the client shows the message). */
  private reply(c: Conn, code: ErrorCode, msg: string): void {
    this.fail(c, code, msg, CLOSE.normal);
  }

  private fail(c: Conn, code: ErrorCode, msg: string, closeCode: number = CLOSE.policy): void {
    this.sendTo(c.sock, { t: 'error', code, msg });
    // A fatal error in a room is a drop like any other: the seat keeps its grace window.
    this.close(c.sock);
    c.sock.close(closeCode, code);
  }

  /** Close a socket that has already been detached from its seat (or never had one). */
  private kick(c: Conn, code: number, reason: string): void {
    this.forget(c);
    c.sock.close(code, reason);
  }

  private forget(c: Conn): void {
    if (!this.conns.delete(c.sock)) return;
    if (c.ip) {
      const n = (this.perIp.get(c.ip) ?? 1) - 1;
      if (n > 0) this.perIp.set(c.ip, n);
      else this.perIp.delete(c.ip);
    }
  }

  private sendTo(sock: RelaySocket, msg: ServerMsg): void {
    try {
      sock.send(JSON.stringify(msg));
    } catch {
      /* the adapter will report the close */
    }
  }
}
