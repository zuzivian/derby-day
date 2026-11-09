// Coach: light, non-blocking help that appears when it is useful and never twice.
//
//  - Match tips: small cards over the pitch, triggered by the situation (how to
//    run, the first time you have the ball, near goal, losing the ball, your first
//    restart). They never pause play, can be dismissed, fade by themselves and are
//    announced for screen readers. CoachTracker is pure (it only reads a
//    MatchState) so it can be unit-tested; mountCoach draws them.
//  - Tab marks: when a level-up reveals a tab, a small spotlight card under it
//    says what it is, once (pendingMark / markHtml).
//
// Which tips and marks were shown is kept in prefs (coachSeen, marks), so a
// returning player, whose prefs hold neither, never sees any. Styles: coach.css.

import { PITCH_H, PITCH_W } from '../sim/constants.ts';
import { attackDir } from '../sim/field.ts';
import type { MatchState } from '../sim/types.ts';
import { announce } from './a11y.ts';
import { isUnlocked, type UnlockId } from '../meta/levels.ts';
import type { Save } from '../meta/game.ts';

export type TipId = 'run' | 'pass' | 'shoot' | 'tackle' | 'restart' | 'freekick' | 'corner';

export interface Tip {
  id: TipId;
  title: string;
  mouse: string;
  keys: string;
  /** Phones: the on-screen Pass and Shoot buttons. */
  touch: string;
}

export const TIPS: Record<TipId, Tip> = {
  run: {
    id: 'run',
    title: 'Run',
    mouse: 'Move the mouse and your player runs to the pointer: further away, faster. On a keyboard, use WASD or the arrows.',
    keys: 'Use WASD or the arrow keys to run, and hold Shift to sprint. With a mouse, your player runs to the pointer instead.',
    touch: 'Drag on the pitch: your player runs to your finger, faster the further it is.',
  },
  pass: {
    id: 'pass',
    title: 'You have the ball',
    mouse: 'Left click to kick off or pass: the ball goes to the pointer. Hold the button for a lofted ball.',
    keys: 'Press Space to kick off and to pass to the teammate you are facing.',
    touch: 'Tap Pass to kick off. Hold it to loft.',
  },
  shoot: {
    id: 'shoot',
    title: 'Shoot!',
    mouse: 'Right click to shoot at the pointer. Hold the button for more power and release to strike.',
    keys: 'Hold F and release to shoot. A longer hold is a harder shot.',
    touch: 'Tap Shoot to hit it at goal.',
  },
  tackle: {
    id: 'tackle',
    title: 'Win it back',
    mouse: 'Right click to tackle. Far from the ball it becomes a slide, which leaves you on the floor.',
    keys: 'Press Space to tackle.',
    touch: 'Tap Shoot without the ball to tackle.',
  },
  restart: {
    id: 'restart',
    title: 'Your restart',
    mouse: 'Your player takes it. Left click to pass where you want. If you wait, the CPU takes it.',
    keys: 'Your player takes it. Press Space to pass. If you wait, the CPU takes it.',
    touch: 'Your player takes it: tap Pass. If you wait, the CPU takes it.',
  },
  freekick: {
    id: 'freekick',
    title: 'Free kick in range',
    mouse: 'Right click on the goal to strike it over the wall: hold for pace, but too much and it sails over. Drag sideways while you hold to bend it. The dots show its flight.',
    keys: 'Hold F and release to strike it over the wall. Too long a hold and it sails over.',
    touch: 'Tap Shoot to strike it over the wall.',
  },
  corner: {
    id: 'corner',
    title: 'Your corner',
    mouse: 'Hold left where the cross should come down: a short hold drives it, a long one floats it. Drag sideways while you hold to swing it in or out. Or click the man short.',
    keys: 'Hold C and release to cross it into the box, or press Space to play it short.',
    touch: 'Hold Pass to cross it into the box, or tap Pass to play it short.',
  },
};

/** The first tip of a first match starts by saying which player is you and which way you attack (team 0 always attacks the right-hand goal). */
export const INTRO = 'You are the yellow ring, attacking the goal on the right.';
/** The same, short enough for a one-line banner: on a narrow phone the card has no room for the long sentence (coach.css). */
export const INTRO_SHORT = 'You are the yellow ring, attacking right →';

/** Tips start a moment after the whistle. */
const RUN_AT_TICK = 45;

/** A shot tip is only worth it when the goal is this close (metres): the sim's shots reach about 35 m and a new player should not be shooting from the halfway line. */
export const SHOOT_RANGE = 28;

/**
 * Watches a match and says which tips have just become relevant, in the order
 * they happened. A tip is offered once, ever: ids in `seen` (restored from
 * prefs) and ids already offered are skipped. A tip that was queued but is no
 * longer true when its turn comes (the ball has gone) is dropped, and one that
 * was cut short can be forgotten so it is offered again.
 */
export class CoachTracker {
  private offered = new Set<TipId>();
  private prevOwnerTeam: number | null = null;
  readonly queue: TipId[] = [];

  constructor(seen: Iterable<string> = []) {
    for (const id of seen) if (id in TIPS) this.offered.add(id as TipId);
  }

  private offer(id: TipId) {
    if (this.offered.has(id)) return;
    this.offered.add(id);
    this.queue.push(id);
  }

  /** Call once per frame with the live state. Returns the ids newly triggered (also left on `queue` until taken). */
  observe(s: MatchState, human: 0 | 1 = 0): TipId[] {
    const before = this.queue.length;
    const me = s.controlled[human];
    const owner = s.ball.owner;
    const ownerTeam = owner >= 0 ? s.players[owner].team : null;
    const live = s.phase === 'play';

    // Which tip comes first depends on the situation: a player on the ball is told about the ball (pass) before how to run,
    // because that is what is on his mind; a player without it is told how to run. The kick-off is a kick (Law 8): taking it is
    // the first pass, so the pass tip is due as soon as he stands over the ball and the click is waiting. Everything else
    // starts a moment after the whistle.
    const started = s.tick >= RUN_AT_TICK && s.phase !== 'fulltime';
    const withBall = me >= 0 && owner === me;
    const kickoffRestart = s.restart?.kind === 'kickoff' && s.phase !== 'fulltime'; // the match opens in phase 'kickoff', then 'restart'
    const kickoff = kickoffRestart && s.restart!.stage === 'ready';
    if (withBall && (kickoff || (started && live))) this.offer('pass');
    // At his own kick-off the run tip waits for the pass tip: the click is what is wanted of him first.
    const toTake = kickoffRestart && s.restart!.taker === me && !kickoff;
    if (started && !toTake) this.offer('run');

    // Shooting is only worth saying when a shot is on: the ball at his feet in open play and the goal within range.
    if (started && live && withBall && this.inShootingRange(s, human, me)) this.offer('shoot');
    // Lost it: the human's team had the ball and the other side has it now.
    if (started && live && this.prevOwnerTeam === human && ownerTeam === 1 - human) this.offer('tackle');
    if (owner >= 0 || live) this.prevOwnerTeam = ownerTeam ?? this.prevOwnerTeam;
    // A free kick with a wall to beat: how to get it over, first (it is a shot, not a pass).
    if (started && this.restartIsMine(s, human) && s.restart!.kind === 'freekick' && s.wall) this.offer('freekick');
    if (started && this.restartIsMine(s, human) && s.restart!.kind === 'corner') this.offer('corner');
    if (started && this.restartIsMine(s, human)) this.offer('restart');
    return this.queue.slice(before);
  }

  /** Within SHOOT_RANGE metres of the centre of the goal the human's team attacks. */
  private inShootingRange(s: MatchState, human: 0 | 1, me: number): boolean {
    const goalX = attackDir(s, human) > 0 ? PITCH_W : 0;
    const p = s.players[me].pos;
    return Math.hypot(p.x - goalX, p.y - PITCH_H / 2) < SHOOT_RANGE;
  }

  private restartIsMine(s: MatchState, human: 0 | 1): boolean {
    const r = s.restart;
    return !!r && r.team === human && r.kind !== 'kickoff' && r.taker >= 0 && r.taker === s.controlled[human] && r.stage !== 'whistle';
  }

  /** Is the situation a tip is about still true? A queued tip waits for its turn, so this is asked when it is taken. */
  relevant(id: TipId, s: MatchState, human: 0 | 1 = 0): boolean {
    const me = s.controlled[human];
    const owner = s.ball.owner;
    const withBall = me >= 0 && owner === me;
    switch (id) {
      case 'run':
        return s.phase !== 'fulltime';
      case 'pass':
        return withBall && (s.phase === 'play' || s.restart?.kind === 'kickoff');
      case 'shoot':
        return withBall && s.phase === 'play' && this.inShootingRange(s, human, me);
      case 'tackle':
        return s.phase === 'play' && (owner < 0 || s.players[owner].team !== human);
      case 'restart':
        return this.restartIsMine(s, human);
      case 'freekick':
        return this.restartIsMine(s, human) && !!s.wall;
      case 'corner':
        return this.restartIsMine(s, human) && s.restart?.kind === 'corner';
    }
  }

  /** The next tip waiting to be shown that is still relevant. Stale ones are dropped and forgotten, so a later chance can offer them again. */
  take(s?: MatchState, human: 0 | 1 = 0): TipId | undefined {
    while (this.queue.length) {
      const id = this.queue.shift()!;
      if (!s || this.relevant(id, s, human)) return id;
      this.offered.delete(id);
    }
    return undefined;
  }

  /** A tip was cut short before it could be read: let it be offered again. */
  forget(id: TipId): void {
    this.offered.delete(id);
  }
}

// ---------------------------------------------------------------------------
// The card over the pitch

export interface CoachOptions {
  /** The live input mode (the controller follows whatever the player touches). Phones always get the touch wording. */
  mode: () => 'mouse' | 'keys';
  /** Tip ids already shown on this browser. */
  seen: string[];
  /** A tip has really been shown (read for a few seconds, or dismissed): remember it so it never comes back. */
  onSeen: (id: string) => void;
  /** 0 or 1: which side the human plays. */
  human?: 0 | 1;
}

export interface CoachHandle {
  /** Per frame. `dtMs` is 0 while the match is paused, so a tip does not run out behind the pause menu. */
  update(s: MatchState, dtMs: number): void;
  /** Hide the card while the pause menu is up. */
  setPaused(paused: boolean): void;
  dismiss(): void;
  dispose(): void;
}

/** A tip counts as shown once it has been up this long, or dismissed with "Got it". */
export const SEEN_AFTER_MS = 4000;
/** The least a tip stays up before another may replace it: about four words a second, and never under five seconds. */
export const minTipMs = (text: string): number => Math.max(5000, text.trim().split(/\s+/).length * 250);
/** Nobody dismisses it: it goes by itself after this. */
const autoHideMs = (text: string): number => Math.max(10_000, minTipMs(text) + 4000);

/** The words of a tip for the way the player is playing right now: touch first, then whichever input was used last. */
export function tipText(id: TipId, mode: 'mouse' | 'keys', touch: boolean, intro = false): string {
  const t = TIPS[id];
  const body = touch ? t.touch : mode === 'keys' ? t.keys : t.mouse;
  return intro ? `${INTRO} ${body}` : body;
}

/** Which on-screen pad a tip is asking the player to tap (phones): it gets a gentle ring while the tip is up. */
const PAD_FOR: Partial<Record<TipId, string>> = { pass: 'pad-pass', restart: 'pad-pass', corner: 'pad-pass', shoot: 'pad-shoot', freekick: 'pad-shoot', tackle: 'pad-shoot' };

export function mountCoach(host: HTMLElement, o: CoachOptions): CoachHandle {
  const human = o.human ?? 0;
  const tracker = new CoachTracker(o.seen);
  const el = document.createElement('div');
  el.className = 'coach-tip';
  el.hidden = true;
  el.setAttribute('data-coach-tip', '');
  host.appendChild(el);
  // Narrow portrait phones show the intro as this banner above the Pass pad instead of inside the card (coach.css).
  const banner = document.createElement('div');
  banner.className = 'coach-intro';
  banner.hidden = true;
  banner.setAttribute('aria-hidden', 'true'); // the card says it for a screen reader
  banner.textContent = INTRO_SHORT;
  host.appendChild(banner);
  const touch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  let shown: TipId | null = null;
  // The first tip a player ever reads also says which player is you; 'intro' is remembered with the tips already seen.
  let introPending = !o.seen.includes('intro');
  let introTip: TipId | null = null;
  let text = '';
  let age = 0;
  let counted = false;

  const countSeen = () => {
    if (shown && !counted) {
      counted = true;
      o.onSeen(shown);
      if (introTip === shown) o.onSeen('intro');
    }
  };
  // The pad the shown tip points at gets .coach-pulse (coach.css); pressing it, dismissing the tip or a new tip clears it.
  let pulsing: HTMLElement | null = null;
  const unpulse = () => {
    pulsing?.classList.remove('coach-pulse');
    pulsing = null;
  };
  const pulse = (id: TipId) => {
    unpulse();
    const pad = touch() ? PAD_FOR[id] : undefined;
    pulsing = pad ? (host.querySelector<HTMLElement>(`#${pad}`) ?? document.getElementById(pad)) : null;
    pulsing?.classList.add('coach-pulse');
  };
  const onPad = (e: Event) => {
    if ((e.target as HTMLElement).closest?.('.coach-pulse')) unpulse();
  };
  host.addEventListener('pointerdown', onPad, true);
  const hide = () => {
    unpulse();
    // Cut short before it could be read: not counted, and it may be offered again.
    if (shown && !counted) {
      tracker.forget(shown);
      if (introTip === shown) {
        introPending = true; // cut short before it could be read: its intro line comes back with it
        introTip = null;
      }
    }
    shown = null;
    el.hidden = true;
    el.classList.remove('on');
    banner.hidden = true;
  };
  const draw = (id: TipId) => {
    const tip = TIPS[id];
    text = tipText(id, o.mode(), touch(), introTip === id);
    const lead = introTip === id ? `<span class="coach-lead">${INTRO} </span>` : '';
    el.dataset.coachTip = id;
    el.innerHTML = `<span class="coach-icon" aria-hidden="true">i</span><span class="coach-text"><b>${tip.title}</b> ${lead}${tipText(id, o.mode(), touch())}</span><button class="coach-x" type="button" aria-label="Got it, dismiss tip: ${tip.title}">Got it</button>`;
  };
  const show = (id: TipId) => {
    shown = id;
    age = 0;
    counted = false;
    // The first tip of a first match also says which player is you and which way you attack.
    if (introPending) {
      introTip = id;
      introPending = false;
    }
    draw(id);
    pulse(id);
    el.hidden = false;
    banner.hidden = introTip !== id;
    // Next frame, so the fade-in runs.
    requestAnimationFrame(() => el.classList.add('on'));
    announce(`Tip. ${TIPS[id].title}. ${text}`);
  };
  const onClick = (e: Event) => {
    if ((e.target as HTMLElement).closest('.coach-x')) {
      countSeen(); // "Got it" means it was read
      hide();
    }
  };
  el.addEventListener('click', onClick);

  let lastState: MatchState | null = null;
  let held = false; // paused, a replay or a goal/card word is up: the tip is hidden, so it neither ages nor gets replaced or announced
  let frozen = false; // e2e only: frames do not move the tip clock, only hook.advance does
  const step = (s: MatchState, dtMs: number, redraw = dtMs > 0) => {
    lastState = s;
    tracker.observe(s, human);
    if (shown) {
      age += dtMs;
      if (!counted && age >= SEEN_AFTER_MS) countSeen();
      if (redraw && text !== tipText(shown, o.mode(), touch(), introTip === shown)) { draw(shown); pulse(shown); } // the player switched input: say it their way
      if (age >= autoHideMs(text)) hide();
      // A fresher situation replaces a tip that has had time to be read, and only if it is still true.
      else if (!held && tracker.queue.length && age >= minTipMs(text)) hide();
    }
    if (!shown && !held && tracker.queue.length && s.phase !== 'fulltime') {
      const id = tracker.take(s, human);
      if (id) show(id);
    }
  };
  const handle: CoachHandle = {
    update(s, dtMs) {
      step(s, frozen ? 0 : dtMs, dtMs > 0);
    },
    setPaused(paused) {
      held = paused;
      el.classList.toggle('paused', paused);
      banner.classList.toggle('paused', paused);
    },
    dismiss: hide,
    dispose() {
      el.removeEventListener('click', onClick);
      host.removeEventListener('pointerdown', onPad, true);
      unpulse();
      el.remove();
      banner.remove();
      if (e2eHook && (globalThis as { __derbyCoach?: unknown }).__derbyCoach === hook) delete (globalThis as { __derbyCoach?: unknown }).__derbyCoach;
    },
  };
  // End-to-end tests set window.__e2e before the page loads (as for window.__derbyMatch in matchView.ts). They get the
  // coach's own tip clock, so "a tip holds for N seconds" is measured in tip time, not in wall time that a slow
  // software renderer stretches, and can advance it without waiting for frames.
  const e2eHook = !!(globalThis as { __e2e?: boolean }).__e2e;
  const hook = {
    state: () => ({ shown, age, counted, minMs: shown ? minTipMs(text) : 0, seenAfterMs: SEEN_AFTER_MS, queue: [...tracker.queue] }),
    advance: (ms: number) => {
      if (lastState) step(lastState, ms);
    },
    // Hold the tip clock still, so a slow runner's wall time between test steps cannot age or replace a tip.
    freeze: () => {
      frozen = true;
    },
  };
  if (e2eHook) (globalThis as { __derbyCoach?: unknown }).__derbyCoach = hook;
  return handle;
}

// ---------------------------------------------------------------------------
// Tab marks: the spotlight on a newly revealed tab

export interface TabMark {
  /** Tab (screen id) the mark points at. */
  screen: string;
  title: string;
  text: string;
}

/** Tabs that appear with an unlock, in the order they open. */
const MARKS: { screen: string; unlock: UnlockId; title: string; text: string }[] = [
  { screen: 'squad', unlock: 'squad', title: 'New: Squad', text: 'See your players and pick the starting eleven.' },
  { screen: 'club', unlock: 'club', title: 'New: Club', text: 'News, replays, Practice skills and your club level live here.' },
  { screen: 'training', unlock: 'training', title: 'New: Training', text: 'Spend the sessions you earn on player attributes.' },
  { screen: 'competitions', unlock: 'cup', title: 'New: Competitions', text: 'The Cup is open: eight clubs, three rounds, a trophy.' },
  { screen: 'transfers', unlock: 'transfers', title: 'New: Transfers', text: 'Sign players from the market and sell to CPU clubs.' },
  { screen: 'ladder', unlock: 'ladder', title: 'New: Ladder', text: 'See where your club stands against all 32.' },
];

/** First-visit hints: a tab's one-line "why you'll like it" and how to start, shown above its content until you leave or press Got it (kept in `marks` as hint:<screen>). */
const HINTS: Record<string, string> = {
  squad: 'Your starting eleven: a stronger XI wins more. Swap players into slots, or let Pick my best XI do it.',
  club: 'Home base: your Elo history, replays of your matches, Practice skills drills and every unlock still to come.',
  training: 'Tap a player, then Train an attribute. Every match earns sessions, and young ▲ Rising players grow fastest.',
  transfers: 'Spend your budget on better players, or sell spares for 80% of their value. A signing can walk into your XI.',
};

/** The hint for `screen` if this is its first visit (club level 12 and under). `marks` undefined means the player predates the coach: none. */
export function pendingHint(marks: string[] | undefined, screen: string, level: number): string | null {
  return marks && level < 12 && !marks.includes(`hint:${screen}`) ? (HINTS[screen] ?? null) : null;
}

export function hintHtml(screen: string, text: string): string {
  return `<p class="tab-hint" role="note" data-hint="${screen}"><span>${text}</span><button class="btn small ghost" type="button" data-action="hint-ok" data-screen="${screen}">Got it</button></p>`;
}

/** The first revealed tab that has not been pointed out yet, or null. `marks` undefined means the player predates marks: none. */
export function pendingMark(save: Save, marks: string[] | undefined, current: string): TabMark | null {
  if (!marks) return null;
  for (const m of MARKS) {
    if (marks.includes(m.screen)) continue;
    if (!isUnlocked(save, m.unlock)) continue;
    // Already on that tab: it is found.
    if (m.screen === current) continue;
    return m;
  }
  return null;
}

/** A revealed tab that has not been visited yet: it keeps a dot in the tab bar until you open it (the card and ring show once, on Home). */
export const isNewTab = (save: Save, marks: string[] | undefined, screen: string, current: string): boolean =>
  !!marks && screen !== current && MARKS.some((m) => m.screen === screen && isUnlocked(save, m.unlock)) && !marks.includes(screen);

/** The player is on `screen`: if it is a tab that gets a mark, the mark counts as seen. Returns true when `marks` changed. */
export function acknowledge(marks: string[], screen: string): boolean {
  if (marks.includes(screen) || !MARKS.some((m) => m.screen === screen)) return false;
  marks.push(screen);
  return true;
}

/** Tabs a save has open (and so needs no mark for): what a first-run club's marks start from. */
export function openTabs(save: Save): string[] {
  return ['home', ...MARKS.filter((m) => isUnlocked(save, m.unlock)).map((m) => m.screen)];
}

/** The card under a tab. Placed by placeMark once it is in the page. */
export function markHtml(m: TabMark): string {
  return `<div class="tab-mark" role="group" aria-label="${m.title}" data-mark="${m.screen}"><b>${m.title}</b><span>${m.text}</span><button class="btn small primary" type="button" data-action="mark-ok" data-screen="${m.screen}">Got it</button></div>`;
}

/** Point the mark at its tab: spotlight ring on the tab, card (position: fixed) under it kept inside the viewport. */
export function placeMark(root: HTMLElement, reveal = false): void {
  const card = root.querySelector<HTMLElement>('.tab-mark');
  if (!card) return;
  const tab = root.querySelector<HTMLElement>(`[data-action="nav"][data-screen="${card.dataset.mark}"]`);
  if (!tab) return;
  tab.classList.add('coach-spot');
  // Only when the mark first appears: doing it on every scroll event would fight the player's own scrolling.
  if (reveal) tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  const r = tab.getBoundingClientRect();
  const w = card.offsetWidth;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  card.style.left = `${left}px`;
  card.style.top = `${r.bottom + 10}px`;
  card.style.setProperty('--arrow-x', `${Math.max(14, Math.min(w - 14, r.left + r.width / 2 - left))}px`);
}
