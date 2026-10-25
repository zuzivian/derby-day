// How sides attack the final third, measured from a headless match. Pure (no
// DOM): scripts/attack-probe.ts prints it per mentality over many matches,
// scripts/balance.ts prints the totals and asserts the shot targets, and
// tests/attack.test.ts checks the directions on fixed seeds.
//
// An AttackObserver watches the state after every step() and counts, for each
// side, in open play only (set pieces are left out):
//   box entries    the side gets the ball under control in the opponents' penalty
//                  area after not having it there: by a carry (he ran it in), a
//                  pass (a teammate's pass he took there), a cross (a lofted ball
//                  from a wide area of the final third) or other (a loose ball)
//   edge spells    possessions in which the side had the ball 18-28 m from goal,
//                  and how many of those went on to a box entry
//   through balls  a pass played from behind the opponents' second-last defender
//                  that travels beyond him; completed when a teammate gets the
//                  next touch and it is not given offside
//   runs in behind an attacker who crosses that line at speed while his side has
//                  the ball (or it is on its way from his side's pass)
//   cut-backs      a ground pass from near the byline (within 16 m of it, wide of
//                  the six-yard box) played back toward their own goal; completed
//                  when a teammate has it under control within 29 m of goal
//   crosses        lofted passes from wide in the final third; completed when a
//                  teammate gets the first touch in the box
//   shots          by distance band (shotProbe's bands) and in the box, goals put
//                  down to the last shot as shotProbe does, and xG: a standard
//                  distance-and-angle model of real open-play shots, independent of
//                  the AI's own estimate, so it rates the chances the AI creates.

import { BOX_DEPTH, BOX_W, GOAL_W, PITCH_H, PITCH_W, TICK_HZ, type Mentality } from '../sim/constants.ts';
import { attackDir, inOffsidePosition, oppGoal, secondLastOpponentX, teamX } from '../sim/field.ts';
import { createMatch, step, type MatchOptions } from '../sim/match.ts';
import type { HumanInput, MatchState, TeamInputs } from '../sim/types.ts';
import { SHOT_BANDS, SHOT_BAND_LABELS } from './shotProbe.ts';

const MID_Y = PITCH_H / 2;

export interface AttackTally {
  /** Team-matches counted (one per side per match). */
  matches: number;
  goals: number;
  entries: { carry: number; pass: number; cross: number; other: number };
  /** Ticks an attacker had the ball in the box. */
  boxTicks: number;
  edgeSpells: number;
  edgeToBox: number;
  throughAtt: number;
  throughCmp: number;
  runs: number;
  cutAtt: number;
  cutCmp: number;
  crossAtt: number;
  crossCmp: number;
  shots: number[];
  goalsBy: number[];
  boxShots: number;
  boxGoals: number;
  xg: number;
  passes: number;
  passAttempts: number;
}

export const emptyAttack = (): AttackTally => ({
  matches: 0,
  goals: 0,
  entries: { carry: 0, pass: 0, cross: 0, other: 0 },
  boxTicks: 0,
  edgeSpells: 0,
  edgeToBox: 0,
  throughAtt: 0,
  throughCmp: 0,
  runs: 0,
  cutAtt: 0,
  cutCmp: 0,
  crossAtt: 0,
  crossCmp: 0,
  shots: SHOT_BANDS.map(() => 0),
  goalsBy: SHOT_BANDS.map(() => 0),
  boxShots: 0,
  boxGoals: 0,
  xg: 0,
  passes: 0,
  passAttempts: 0,
});

export function addAttack(into: AttackTally, t: AttackTally): void {
  for (const k of Object.keys(t) as (keyof AttackTally)[]) {
    const v = t[k];
    if (typeof v === 'number') (into[k] as number) += v;
    else if (Array.isArray(v)) v.forEach((x, i) => ((into[k] as number[])[i] += x));
    else for (const e of Object.keys(v) as (keyof AttackTally['entries'])[]) into.entries[e] += v[e];
  }
}

/** In the penalty area `team` is attacking. */
export function inAttackBox(team: 0 | 1, p: { x: number; y: number }): boolean {
  return teamX(team, p.x) > 1 - BOX_DEPTH / PITCH_W && Math.abs(p.y - MID_Y) < BOX_W / 2;
}

/**
 * xG of an open-play shot from `p` at the goal `team` attacks: a logistic in distance and the
 * angle the goal mouth subtends, close to public models of real shots (about 0.4 from 6 m
 * central, 0.2 from the penalty spot, 0.07 from the edge of the box, 0.03 from 25 m).
 */
export function shotXg(team: 0 | 1, p: { x: number; y: number }): number {
  const g = oppGoal(team);
  const dx = Math.abs(g.x - p.x);
  const d = Math.sqrt(dx * dx + (g.y - p.y) ** 2);
  const angle = Math.abs(Math.atan2(g.y + GOAL_W / 2 - p.y, dx) - Math.atan2(g.y - GOAL_W / 2 - p.y, dx));
  return 1 / (1 + Math.exp(-(-1.05 - 0.105 * d + 1.45 * angle)));
}

const bandOf = (d: number): number => SHOT_BANDS.findIndex((b) => d < b);

interface Kick {
  by: number;
  team: 0 | 1;
  tick: number;
  through: boolean;
  /** The opponents' second-last defender when it was played (team-x), for through balls. */
  line: number;
  beyond: boolean;
  cross: boolean;
  cut: boolean;
}

/** Watches one match; call observe(s) after every step and finish(s) at the end. */
export class AttackObserver {
  readonly t: [AttackTally, AttackTally] = [emptyAttack(), emptyAttack()];
  private prevOwner = -1;
  private redirected = -1;
  private kick: Kick | null = null;
  /** The last kick by each side, until someone else touches the ball (how a box entry came about). */
  private lastPass: [Kick | null, Kick | null] = [null, null];
  private inBox = [false, false];
  private spellTeam = -1;
  private spellEdge = false;
  private spellBox = false;
  private shots = [0, 0];
  private lastShot: [{ band: number; tick: number } | null, { band: number; tick: number } | null] = [null, null];
  private seen = 0;
  private behind: boolean[] = [];

  observe(s: MatchState): void {
    const b = s.ball;
    for (const team of [0, 1] as const) {
      if (s.stats[team].shots === this.shots[team]) continue;
      this.shots[team] = s.stats[team].shots;
      const k = s.players[b.kickedBy >= 0 ? b.kickedBy : b.lastTouch];
      if (!k || k.team !== team) continue;
      const band = bandOf(Math.hypot(k.pos.x - oppGoal(team).x, k.pos.y - oppGoal(team).y));
      const t = this.t[team];
      t.shots[band]++;
      if (inAttackBox(team, k.pos)) t.boxShots++;
      t.xg += shotXg(team, k.pos);
      this.lastShot[team] = { band, tick: s.tick };
      (this.lastShot[team] as { box?: boolean }).box = inAttackBox(team, k.pos);
    }
    for (; this.seen < s.events.length; this.seen++) {
      const e = s.events[this.seen];
      if (e.kind !== 'goal' || e.ownGoal) continue;
      const l = this.lastShot[e.team];
      if (l && s.tick - l.tick <= 3 * TICK_HZ) {
        this.t[e.team].goalsBy[l.band]++;
        if ((l as { box?: boolean }).box) this.t[e.team].boxGoals++;
      }
      this.lastShot[e.team] = null;
    }

    if (s.phase !== 'play') {
      this.resolve(s, false);
      this.prevOwner = -1;
      this.redirected = b.redirectedAt ?? -1;
      this.inBox = [false, false];
      this.endSpell();
      this.lastPass = [null, null];
      return;
    }

    // A new kick this tick (a pass, shot, clearance or header).
    if ((b.redirectedAt ?? -1) !== this.redirected && b.kickedBy >= 0 && b.owner < 0) {
      // A header or first-time shot off the tracked pass is its first touch.
      this.resolve(s, !!this.kick && b.kickedBy !== this.kick.by);
      const p = s.players[b.kickedBy];
      const team = p.team;
      const open = !b.setPiece;
      const pass = b.passFrom === p.i && open;
      const lofted = b.z > 0.01 || b.vz > 0.01;
      const px = teamX(team, b.pos.x);
      const line = secondLastOpponentX(s, team);
      const k: Kick = {
        by: p.i,
        team,
        tick: s.tick,
        through: pass && px < line - 0.005,
        line,
        beyond: false,
        cross: pass && lofted && px > 0.66 && Math.abs(b.pos.y - MID_Y) > BOX_W / 2 - 6,
        cut: pass && !lofted && px > 1 - 16 / PITCH_W && Math.abs(b.pos.y - MID_Y) > 5 && b.vel.x * attackDir(team) < 0,
      };
      if (k.cross) this.t[team].crossAtt++;
      if (k.cut) this.t[team].cutAtt++;
      this.kick = k.through || k.cross || k.cut ? k : null;
      this.lastPass[team] = open ? k : null;
      this.lastPass[team === 0 ? 1 : 0] = null;
    }
    this.redirected = b.redirectedAt ?? -1;

    const k = this.kick;
    if (k && k.through && !k.beyond && b.lastTouch === k.by && teamX(k.team, b.pos.x) > k.line + 1 / PITCH_W) {
      k.beyond = true;
      this.t[k.team].throughAtt++;
    }
    if (k && b.lastTouch !== k.by) this.resolve(s, true);

    const owner = b.owner >= 0 ? s.players[b.owner] : null;
    // Who is attacking right now: the side with the ball, or the side whose kick is in flight.
    const att = owner ? owner.team : b.kickedBy >= 0 ? s.players[b.kickedBy].team : -1;

    // Runs in behind.
    if (att >= 0) {
      const line = secondLastOpponentX(s, att as 0 | 1);
      const dir = attackDir(att as 0 | 1);
      for (const p of s.players) {
        if (p.team !== att || p.role === 'GK' || p.sentOff || p.i === b.owner) continue;
        const x = teamX(p.team, p.pos.x);
        const was = this.behind[p.i] ?? false;
        if (!was && x > line + 0.5 / PITCH_W && x > 0.5 && p.vel.x * dir > 4) {
          this.t[p.team].runs++;
          this.behind[p.i] = true;
        } else if (was && x < line) this.behind[p.i] = false;
      }
    }

    if (owner) {
      const team = owner.team;
      const t = this.t[team];
      if (this.spellTeam !== team) {
        this.endSpell();
        this.spellTeam = team;
      }
      const d = Math.hypot(owner.pos.x - oppGoal(team).x, owner.pos.y - oppGoal(team).y);
      if (d >= 18 && d <= 28) this.spellEdge = true;
      const box = inAttackBox(team, owner.pos);
      if (box) {
        t.boxTicks++;
        if (!this.inBox[team]) {
          const lp = this.lastPass[team];
          if (this.prevOwner === owner.i) t.entries.carry++;
          else if (lp && lp.by !== owner.i && s.players[lp.by].team === team) {
            if (lp.cross) t.entries.cross++;
            else t.entries.pass++;
          } else t.entries.other++;
          this.spellBox = true;
        }
      }
      this.inBox[team] = box;
      this.inBox[team === 0 ? 1 : 0] = false;
      this.lastPass[team] = null;
    }
    this.prevOwner = b.owner;
  }

  /** The tracked pass has had its first touch by someone else (or play stopped). */
  private resolve(s: MatchState, touched: boolean): void {
    const k = this.kick;
    if (!k) return;
    this.kick = null;
    if (!touched || s.phase !== 'play') return;
    const b = s.ball;
    const m = s.players[b.lastTouch];
    if (!m || m.team !== k.team) return;
    const t = this.t[k.team];
    if (k.beyond && !(s.offside && s.offside.team === k.team && s.offside.players.includes(m.i))) t.throughCmp++;
    if (k.cross && inAttackBox(k.team, b.pos)) t.crossCmp++;
    if (k.cut && teamX(k.team, b.pos.x) > 1 - 29 / PITCH_W) t.cutCmp++;
  }

  private endSpell(): void {
    if (this.spellTeam >= 0 && this.spellEdge) {
      this.t[this.spellTeam].edgeSpells++;
      if (this.spellBox) this.t[this.spellTeam].edgeToBox++;
    }
    this.spellTeam = -1;
    this.spellEdge = false;
    this.spellBox = false;
  }

  finish(s: MatchState): [AttackTally, AttackTally] {
    this.endSpell();
    for (const team of [0, 1] as const) {
      const t = this.t[team];
      t.matches = 1;
      t.goals = s.score[team];
      t.passes = s.stats[team].passes;
      t.passAttempts = s.stats[team].passAttempts;
    }
    return this.t;
  }
}

/** Play one match to the end, observing it. `drive` gives the human inputs, if any side has a human. */
export function measureAttack(
  o: MatchOptions,
  drive?: (s: MatchState) => HumanInput | TeamInputs | undefined,
): { state: MatchState; teams: [AttackTally, AttackTally] } {
  const s = createMatch(o.humans || o.humanTeam !== undefined ? o : { ...o, humans: [false, false] });
  const obs = new AttackObserver();
  while (s.phase !== 'fulltime') {
    step(s, drive?.(s));
    obs.observe(s);
  }
  return { state: s, teams: obs.finish(s) };
}

const f = (v: number, w = 5, d = 1) => v.toFixed(d).padStart(w);
const pct = (a: number, b: number) => (b ? (100 * a) / b : 0);

export const ATTACK_HEADER = `${''.padEnd(13)}  GF/m  xG/m  sh/m  box%  boxCv  18-30%  18-30Cv  entries/m (carry pass cross other)  edge>box%  thru/m cmp%  runs/m  cut/m cmp%  cross/m cmp%  pass%`;

/** One row of the attack table: per team-match rates. */
export function attackRow(label: string, t: AttackTally): string {
  const n = Math.max(1, t.matches);
  const shots = t.shots.reduce((a, b) => a + b, 0);
  const e = t.entries;
  const entries = e.carry + e.pass + e.cross + e.other;
  return (
    `${label.padEnd(13)} ${f(t.goals / n, 5, 2)} ${f(t.xg / n, 5, 2)} ${f(shots / n)} ${f(pct(t.boxShots, shots))}% ${f(pct(t.boxGoals, t.boxShots))}%  ${f(pct(t.shots[2], shots))}%  ${f(pct(t.goalsBy[2], t.shots[2]))}%  ` +
    `${f(entries / n)} (${f(e.carry / n, 4)} ${f(e.pass / n, 4)} ${f(e.cross / n, 4)} ${f(e.other / n, 4)})       ${f(pct(t.edgeToBox, t.edgeSpells))}%  ${f(t.throughAtt / n)} ${f(pct(t.throughCmp, t.throughAtt), 4, 0)}% ${f(t.runs / n, 6)}  ${f(t.cutAtt / n)} ${f(pct(t.cutCmp, t.cutAtt), 4, 0)}%  ${f(t.crossAtt / n, 6)} ${f(pct(t.crossCmp, t.crossAtt), 4, 0)}%  ${f(pct(t.passes, t.passAttempts), 4, 0)}%`
  );
}

/** Shots by zone for the tally: share and conversion, like shotProbe's table plus the box. */
export function zoneTable(t: AttackTally): string {
  const shots = t.shots.reduce((a, b) => a + b, 0) || 1;
  const rows = SHOT_BAND_LABELS.map((label, i) => `  ${label.padEnd(8)} ${String(t.shots[i]).padStart(5)} shots (${f(pct(t.shots[i], shots), 4, 0)}%)  ${String(t.goalsBy[i]).padStart(4)} goals  ${f(pct(t.goalsBy[i], t.shots[i]))}%`);
  rows.push(`  ${'in box'.padEnd(8)} ${String(t.boxShots).padStart(5)} shots (${f(pct(t.boxShots, shots), 4, 0)}%)  ${String(t.boxGoals).padStart(4)} goals  ${f(pct(t.boxGoals, t.boxShots))}%`);
  return rows.join('\n');
}

export type MentalityTallies = Record<Mentality, AttackTally>;

/**
 * A scripted human for `measureAttack`: with the ball he looks up for the most advanced open
 * runner: an onside teammate going forward whose spot 0.7 s ahead has no opponent within 2.2 m
 * and a lane clear by 1.5 m, and click-passes to that spot (the way a player picks out a run).
 * After half a second with no run on he plays it to the most advanced open teammate instead; in
 * the box with a sight of goal he shoots; with nobody open he runs at goal. Without
 * the ball the pointer sits on the ball and he tackles a carrier within 2 m.
 */
export function scriptedRunnerHuman(team: 0 | 1): (s: MatchState) => HumanInput {
  let held = 0;
  let cursor = { x: PITCH_W / 2, y: MID_Y };
  return (s) => {
    const b = s.ball;
    const me = s.players[s.controlled[team]];
    if (s.phase !== 'play' || !me) return { cursor };
    if (b.owner === me.i) {
      const goal = oppGoal(team);
      const dGoal = Math.hypot(goal.x - me.pos.x, goal.y - me.pos.y);
      held++;
      if (held < 6) return { cursor: (cursor = { ...goal }), moved: true };
      if (inAttackBox(team, me.pos) && dGoal < 16) {
        const aim = { x: goal.x, y: goal.y + (me.pos.y < MID_Y ? 2.6 : -2.6) };
        return { cursor: (cursor = aim), aim, shoot: 0.75, moved: true };
      }
      // A runner going forward with open grass ahead of him, picked out as soon as he is on;
      // after half a second with none, the most advanced open teammate.
      let run: { x: number; y: number } | null = null;
      let best: { x: number; y: number } | null = null;
      for (const t of s.players) {
        if (t.team !== team || t.i === me.i || t.role === 'GK' || t.sentOff) continue;
        // Where he will be when the ball gets there (a click pass travels at about 14 m/s).
        const tl = Math.min(1.6, Math.max(0.5, Math.hypot(t.pos.x - me.pos.x, t.pos.y - me.pos.y) / 14));
        const lead = { x: t.pos.x + t.vel.x * tl, y: t.pos.y + t.vel.y * tl };
        const d = Math.hypot(lead.x - me.pos.x, lead.y - me.pos.y);
        const running = t.vel.x * attackDir(team) > 4;
        if (d < 5 || d > (me.role === 'GK' ? 40 : running ? 38 : 30) || inOffsidePosition(s, t)) continue;
        let open = true;
        for (const o of s.players) {
          if (o.team === team || o.sentOff) continue;
          if (Math.hypot(o.pos.x - lead.x, o.pos.y - lead.y) < 2.2 || segDist(o.pos, me.pos, lead) < 1.5) open = false;
        }
        if (!open) continue;
        if (running && teamX(team, lead.x) > teamX(team, me.pos.x) + 0.05 && (!run || teamX(team, lead.x) > teamX(team, run.x))) run = lead;
        if (!best || teamX(team, lead.x) > teamX(team, best.x)) best = lead;
      }
      const pick = run ?? (held >= 30 && best && (me.role === 'GK' || teamX(team, best.x) > teamX(team, me.pos.x) - 0.08) ? best : null);
      if (pick) {
        held = 0;
        cursor = pick;
        return { cursor, aim: cursor, pass: true, moved: true };
      }
      if (held >= 30) held = 24;
      return { cursor: (cursor = { ...goal }), moved: true };
    }
    held = 0;
    cursor = { ...b.pos };
    const carrier = b.owner >= 0 ? s.players[b.owner] : null;
    const tackle = !!carrier && carrier.team !== team && Math.hypot(carrier.pos.x - me.pos.x, carrier.pos.y - me.pos.y) < 2;
    return { cursor, moved: true, tackle };
  };
}

function segDist(p: { x: number; y: number }, a: { x: number; y: number }, c: { x: number; y: number }): number {
  const abx = c.x - a.x;
  const aby = c.y - a.y;
  const l2 = abx * abx + aby * aby;
  const u = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2));
  return Math.hypot(p.x - (a.x + abx * u), p.y - (a.y + aby * u));
}
