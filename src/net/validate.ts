// Everything a peer sends is untrusted. These functions turn whatever arrived
// into well-formed values, or null when it can't be one:
//
//   cleanTeam / cleanStart  the room handshake (team setups end up in HTML and in the sim)
//   cleanInput              one tick of input (ends up in the sim)
//   cleanLockstepMsg        a lockstep message's shape
//
// Both sides run their *own* data through the same functions too (the host its
// start, each side its sampled inputs), so a field these functions drop is
// dropped on both screens alike and can never cause a desync. A new field on
// HumanInput or TeamSetup has to be added here before it works online.

import type { CrestPattern } from '../meta/names.ts';
import { CREST_PATTERNS } from '../meta/names.ts';
import { FORMATION_IDS, isMentality, MENTALITY_IDS, mentalityOf, TEAM_SIZE, type FormationId, type Role } from '../sim/constants.ts';
import type { HumanInput, PlayerSetup, SimAttrs, TeamSetup } from '../sim/types.ts';
import type { Vec } from '../sim/vec.ts';
import type { LockstepMsg } from './lockstep.ts';
import type { StartInfo } from './room.ts';

const ROLES: Role[] = ['GK', 'DEF', 'MID', 'FWD'];
const ATTRS: (keyof SimAttrs)[] = ['pace', 'shooting', 'passing', 'dribbling', 'defending', 'stamina', 'goalkeeping'];
const HEX = /^#[0-9a-fA-F]{6}$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);

/**
 * Display text: no markup characters (< > " ` \\) or control characters, spaces collapsed, at most
 * `max` characters (counted by code point, so an emoji is never cut in half). & and ' are kept for
 * names like "Brighton & Hove" or "D'Arcy": every place that puts a name in HTML escapes it, and
 * attributes are double-quoted. Null when nothing is left.
 */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const flat = v.replace(/[\u0000-\u001f\u007f<>"`\\]/g, '').replace(/\s+/g, ' ').trim();
  const s = Array.from(flat).slice(0, max).join('').trim();
  return s || null;
}

function cleanAttrs(v: unknown): SimAttrs | null {
  if (!isObj(v)) return null;
  const o = {} as SimAttrs;
  for (const k of ATTRS) {
    const n = num(v[k], 0, 1);
    if (n === null) return null;
    o[k] = n;
  }
  return o;
}

function cleanPlayer(v: unknown): PlayerSetup | null {
  if (!isObj(v)) return null;
  const id = typeof v.id === 'string' && /^[A-Za-z0-9_~.-]{1,40}$/.test(v.id) ? v.id : null;
  const name = cleanText(v.name, 32);
  const number = typeof v.number === 'number' && Number.isInteger(v.number) && v.number >= 1 && v.number <= 99 ? v.number : null;
  const role = ROLES.includes(v.role as Role) ? (v.role as Role) : null;
  const attrs = cleanAttrs(v.attrs);
  if (id === null || name === null || number === null || role === null || !attrs) return null;
  return { id, name, number, role, attrs };
}

/**
 * The TeamSetup and PlayerSetup fields cleanTeam knows. Typed as full records: a new field (a tactics
 * setting, say) is a type error here until cleanTeam handles it, instead of being dropped online.
 */
export const TEAM_FIELDS: Record<keyof TeamSetup, true> = { name: true, short: true, primary: true, secondary: true, players: true, aiSkill: true, formation: true, mentality: true };
export const PLAYER_FIELDS: Record<keyof PlayerSetup, true> = { id: true, name: true, number: true, role: true, attrs: true };

/** A team setup from the other side, or null. Exactly TEAM_SIZE well-formed players with unique ids. */
export function cleanTeam(v: unknown): TeamSetup | null {
  if (!isObj(v) || !Array.isArray(v.players) || v.players.length !== TEAM_SIZE) return null;
  const name = cleanText(v.name, 40);
  const short = typeof v.short === 'string' && /^[A-Z0-9]{1,4}$/.test(v.short) ? v.short : null;
  const primary = typeof v.primary === 'string' && HEX.test(v.primary) ? v.primary : null;
  const secondary = typeof v.secondary === 'string' && HEX.test(v.secondary) ? v.secondary : null;
  const aiSkill = num(v.aiSkill, 0, 1);
  const players = v.players.map(cleanPlayer);
  if (name === null || short === null || primary === null || secondary === null || aiSkill === null || players.some((p) => !p)) return null;
  if (new Set(players.map((p) => p!.id)).size !== TEAM_SIZE) return null;
  const formation: FormationId = FORMATION_IDS.includes(v.formation as FormationId) ? (v.formation as FormationId) : '4-4-2';
  const team: TeamSetup = { name, short, primary, secondary, players: players as PlayerSetup[], aiSkill, formation };
  // Balanced is left off, as toTeamSetup does.
  if (isMentality(v.mentality) && v.mentality !== 'balanced') team.mentality = v.mentality;
  return team;
}

/** The colour pairs avoidClash() can give the away side: its own, swapped, or the neutral fallback. */
function kitOk(t: TeamSetup, mine: TeamSetup): boolean {
  const pairs = [
    [mine.primary, mine.secondary],
    [mine.secondary, mine.primary],
    ['#1c1c1c', '#f5f5f5'],
    ['#f5f5f5', '#1c1c1c'],
  ];
  return pairs.some(([p, q]) => t.primary.toLowerCase() === p.toLowerCase() && t.secondary.toLowerCase() === q.toLowerCase());
}

/**
 * Is `theirs` (the away team in the host's start) the guest's own team, `mine`? The host may only
 * change what the room handshake changes: the kit (to avoid a clash) and " II" on a name that
 * matches the host's. Everything that plays (players, attributes, formation, skill) must be ours,
 * so a host can't hand the guest eleven zero-rated players.
 */
export function isOwnTeam(theirs: TeamSetup, mine: TeamSetup): boolean {
  const names = [mine.name, cleanText(`${mine.name} II`, 40)];
  if (!names.includes(theirs.name) || theirs.short !== mine.short || !kitOk(theirs, mine)) return false;
  if (theirs.aiSkill !== mine.aiSkill || (theirs.formation ?? '4-4-2') !== (mine.formation ?? '4-4-2') || mentalityOf(theirs.mentality) !== mentalityOf(mine.mentality)) return false;
  return theirs.players.length === mine.players.length && theirs.players.every((p, i) => {
    const q = mine.players[i];
    return p.id === q.id && p.name === q.name && p.number === q.number && p.role === q.role && ATTRS.every((k) => p.attrs[k] === q.attrs[k]);
  });
}

export function cleanCrest(v: unknown): CrestPattern {
  return CREST_PATTERNS.includes(v as CrestPattern) ? (v as CrestPattern) : 'plain';
}

/** The host's start message, or null. The host runs its own through this too, so both sides use identical data. */
export function cleanStart(v: unknown): StartInfo | null {
  if (!isObj(v)) return null;
  const home = cleanTeam(v.home);
  const away = cleanTeam(v.away);
  const seed = typeof v.seed === 'number' && Number.isInteger(v.seed) ? v.seed | 0 : null;
  const halfSeconds = typeof v.halfSeconds === 'number' && Number.isInteger(v.halfSeconds) && v.halfSeconds >= 1 && v.halfSeconds <= 900 ? v.halfSeconds : null;
  const delay = typeof v.delay === 'number' && Number.isInteger(v.delay) && v.delay >= 1 && v.delay <= 12 ? v.delay : null;
  if (!home || !away || seed === null || halfSeconds === null || delay === null) return null;
  const crests = Array.isArray(v.crests) ? v.crests : [];
  return { seed, home, away, crests: [cleanCrest(crests[0]), cleanCrest(crests[1])], halfSeconds, delay };
}

// ---------------------------------------------------------------------------
// Inputs

/** Far enough outside the pitch for any pointer, finite. */
const COORD = 200;

function cleanVec(v: unknown, lim: number): Vec | undefined {
  if (!isObj(v)) return undefined;
  const x = num(v.x, -lim, lim);
  const y = num(v.y, -lim, lim);
  return x === null || y === null ? undefined : { x, y };
}

/**
 * Every HumanInput field cleanInput handles. Typed as a full record, so a new field on HumanInput is a
 * type error here until cleanInput passes it through: otherwise it would silently not work online.
 */
export const INPUT_FIELDS: Record<keyof HumanInput, true> = {
  cursor: true,
  dir: true,
  pass: true,
  loft: true,
  shoot: true,
  tackle: true,
  select: true,
  sprint: true,
  switchPlayer: true,
  aim: true,
  moved: true,
  tactic: true,
  curl: true,
};

/** One tick of input with every field finite and in range; anything else is dropped. Never null: junk becomes {}. */
export function cleanInput(v: unknown): HumanInput {
  if (!isObj(v)) return {};
  const o: HumanInput = {};
  const cursor = cleanVec(v.cursor, COORD);
  if (cursor) o.cursor = cursor;
  const dir = cleanVec(v.dir, 1);
  if (dir) o.dir = dir;
  if (v.pass === true) o.pass = true;
  const loft = num(v.loft, 0, 1);
  if (loft !== null) o.loft = loft;
  const shoot = num(v.shoot, 0, 1);
  if (shoot !== null) o.shoot = shoot;
  if (v.tackle === true) o.tackle = true;
  if (v.select === true) o.select = true;
  if (v.sprint === true) o.sprint = true;
  if (v.switchPlayer === true) o.switchPlayer = true;
  const aim = cleanVec(v.aim, COORD);
  if (aim) o.aim = aim;
  if (v.moved === true) o.moved = true;
  // Quick tactics: a mentality step, 1 (Park the bus) to 5 (High press).
  if (typeof v.tactic === 'number' && Number.isInteger(v.tactic) && v.tactic >= 1 && v.tactic <= MENTALITY_IDS.length) o.tactic = v.tactic;
  const curl = num(v.curl, -1, 1);
  if (curl !== null && curl !== 0) o.curl = curl;
  return o;
}

/** Largest batch of inputs one message may carry (lockstep never sends more than its re-send cap). */
export const MAX_BATCH = 120;

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= 1e9 ? v : null);

/** A lockstep message with the right shape, or null. Inputs are cleaned; their tick range is checked by Lockstep. */
export function cleanLockstepMsg(v: unknown): LockstepMsg | null {
  if (!isObj(v)) return null;
  switch (v.t) {
    case 'in': {
      const from = int(v.from);
      const ack = int(v.ack);
      if (from === null || ack === null || !Array.isArray(v.inputs) || v.inputs.length > MAX_BATCH) return null;
      return { t: 'in', from, ack, inputs: v.inputs.map(cleanInput) };
    }
    case 'fp': {
      const tick = int(v.tick);
      const fp = typeof v.fp === 'number' && Number.isInteger(v.fp) && v.fp >= 0 && v.fp < 2 ** 32 ? v.fp : null;
      return tick === null || fp === null ? null : { t: 'fp', tick, fp };
    }
    case 'ping':
    case 'pong': {
      const n = int(v.n);
      const at = typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : null;
      return n === null || at === null ? null : { t: v.t, n, at };
    }
    case 'bye':
      return { t: 'bye' };
    default:
      return null;
  }
}
