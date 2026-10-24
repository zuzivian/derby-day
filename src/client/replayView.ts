// Replay UI: the goal-highlights viewer, the "Recent replays" list on the Club
// screen, the result-modal buttons, and copy / paste of replay codes.
//
// Everything here hangs off one delegated listener on #app (initReplayUi) and
// uses its own data-replay attributes, so main.ts's data-action switch never
// sees it. The viewer and the code box are body-level layers: re-rendering
// #app does not touch them, and while one is open #app is inert and a
// capture-phase key handler keeps Esc, Tab and the replay keys away from the
// rest of the app.

import { clipsFor, codeSize, decodeReplay, formatSize, ReplaySeeker, type Clip, type Replay } from '../meta/replay.ts';
import { DT } from '../sim/constants.ts';
import { announce, hideToast, reducedMotion, showToast } from './a11y.ts';
import { createMatchRenderer, type MatchRenderer } from './renderer.ts';
import { lastReplay, recentReplays, replaySlots } from './replayStore.ts';

const esc = (t: string | number): string =>
  String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const FOCUSABLE = 'a[href], button:not([disabled]):not([aria-disabled="true"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// ---------------------------------------------------------------------------
// HTML for the management screens

/** Which side the player was on, and how it ended for them. */
function perspective(r: Replay): { us: 0 | 1; res: 'W' | 'D' | 'L'; us_g: number; them_g: number } {
  const us = r.humanTeam === 1 ? 1 : 0;
  const a = r.score[us];
  const b = r.score[1 - us];
  return { us, res: a > b ? 'W' : a === b ? 'D' : 'L', us_g: a, them_g: b };
}

/** Buttons for the result modal: Watch goals (if there were any) and Copy replay code. */
export function resultReplayHtml(): string {
  const last = lastReplay();
  if (!last) return '';
  const goals = last.replay.goals.length;
  return `<div class="replay-actions">
    ${goals ? `<button class="btn" data-replay="watch" data-id="${esc(last.id)}">Watch goals (${goals})</button>` : ''}
    <button class="btn" data-replay="copy" data-id="${esc(last.id)}">Copy replay code</button>
    <span class="muted small">${formatSize(codeSize(last.code))}</span>
  </div>`;
}

/** The "Recent replays" list and the paste box, for the Club screen under Recent. */
export function recentReplaysHtml(): string {
  const list = recentReplays();
  const rows = list
    .map(({ id, code, replay }) => {
      const p = perspective(replay);
      const opp = replay[p.us === 0 ? 'away' : 'home'];
      const goals = replay.goals.length;
      return `<li class="rp-row">
        <span class="res res-${p.res}" aria-label="${p.res === 'W' ? 'Win' : p.res === 'D' ? 'Draw' : 'Defeat'}">${p.res}</span>
        <span class="res-score">${p.us_g}–${p.them_g}</span>
        <span class="res-opp">${esc(opp.name)}<span class="muted small">${esc(replay.label || 'Match')} · ${goals} goal${goals === 1 ? '' : 's'} · ${formatSize(codeSize(code))}</span></span>
        <span class="rp-btns">
          <button class="btn small" data-replay="watch" data-id="${esc(id)}" aria-label="Watch ${esc(replay.home.name)} ${replay.score[0]}, ${esc(replay.away.name)} ${replay.score[1]}">Watch</button>
          <button class="btn small ghost" data-replay="copy" data-id="${esc(id)}" aria-label="Copy replay code for ${esc(opp.name)}">Copy code</button>
        </span>
      </li>`;
    })
    .join('');
  return `<div class="replays">
    <h3 class="eyebrow">Recent replays</h3>
    ${rows ? `<ul class="replay-list">${rows}</ul>` : `<p class="muted small">Your last ${replaySlots()} matches are kept here to watch again.</p>`}
    <div class="replay-paste">
      <label for="replay-paste" class="small">Paste replay code</label>
      <div class="replay-paste-row">
        <input id="replay-paste" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="DD1.…" aria-describedby="replay-paste-msg">
        <button class="btn small" data-replay="paste">Play</button>
      </div>
      <p id="replay-paste-msg" class="small replay-msg" role="status"></p>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Layers: the viewer and the code box

interface Layer {
  el: HTMLElement;
  opener: HTMLElement | null;
  /** Return true when the key was dealt with. */
  onKey?: (e: KeyboardEvent) => boolean;
  close: () => void;
}

let appRoot: HTMLElement | null = null;
const layers: Layer[] = [];

function syncInert() {
  if (appRoot) appRoot.inert = layers.length > 0;
  layers.forEach((l, i) => (l.el.inert = i < layers.length - 1));
}

function onKeyCapture(e: KeyboardEvent) {
  const top = layers[layers.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    top.close();
    return;
  }
  if (e.key === 'Tab') {
    const items = [...top.el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
    const active = document.activeElement as HTMLElement | null;
    const inside = !!active && top.el.contains(active);
    if (items.length && (e.shiftKey ? active === items[0] || !inside : active === items[items.length - 1] || !inside)) {
      e.preventDefault();
      (e.shiftKey ? items[items.length - 1] : items[0]).focus();
    }
    e.stopImmediatePropagation();
    return;
  }
  if (top.onKey?.(e)) e.preventDefault();
  // Nothing typed in a layer reaches the app underneath.
  e.stopImmediatePropagation();
}

function pushLayer(layer: Layer) {
  if (!layers.length) window.addEventListener('keydown', onKeyCapture, true);
  layers.push(layer);
  document.body.appendChild(layer.el);
  syncInert();
}

function popLayer(layer: Layer) {
  const i = layers.indexOf(layer);
  if (i < 0) return;
  layers.splice(i, 1);
  layer.el.remove();
  if (!layers.length) window.removeEventListener('keydown', onKeyCapture, true);
  syncInert();
  const back = layer.opener;
  const target = back && back.isConnected ? back : appRoot?.querySelector<HTMLElement>('[data-replay]') ?? appRoot?.querySelector<HTMLElement>('#main') ?? null;
  target?.focus();
}

// ---------------------------------------------------------------------------
// Copy and paste

function codeBox(code: string, opener: HTMLElement | null) {
  const el = document.createElement('div');
  el.className = 'replay-layer';
  el.innerHTML = `<div class="replay-card replay-codebox" role="dialog" aria-modal="true" aria-labelledby="rc-title">
    <h2 id="rc-title" class="rp-title">Replay code</h2>
    <p class="small">Your browser would not copy it for you. Select all, copy, and send it to a friend: ${formatSize(codeSize(code))}.</p>
    <label class="visually-hidden" for="rc-text">Replay code</label>
    <textarea id="rc-text" class="replay-code" readonly rows="5"></textarea>
    <div class="rp-foot"><button class="btn primary" data-rp="done">Done</button></div>
  </div>`;
  const ta = el.querySelector<HTMLTextAreaElement>('textarea')!;
  ta.value = code;
  const layer: Layer = { el, opener, close: () => popLayer(layer) };
  el.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-rp="done"]')) layer.close();
  });
  pushLayer(layer);
  ta.focus();
  ta.select();
  return ta;
}

/** Must run inside the click handler so the clipboard call keeps the user gesture. */
function copyCode(code: string, opener: HTMLElement | null) {
  const fallback = () => {
    // Older browsers and locked-down iframes: select the text and try the legacy command.
    const ta = codeBox(code, opener);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      /* the box stays open for a manual copy */
    }
    if (ok) {
      showToast('Replay code copied.');
      announce('Replay code copied.');
    }
    return ta;
  };
  let p: Promise<void> | undefined;
  try {
    p = navigator.clipboard?.writeText(code);
  } catch {
    p = undefined;
  }
  if (!p) {
    fallback();
    return;
  }
  p.then(
    () => {
      showToast(`Replay code copied (${formatSize(codeSize(code))}).`);
      announce('Replay code copied.');
    },
    () => fallback(),
  );
}

function playPasted(input: HTMLInputElement, opener: HTMLElement | null) {
  const msg = document.getElementById('replay-paste-msg');
  const say = (t: string, bad: boolean) => {
    if (msg) {
      msg.textContent = t;
      msg.classList.toggle('bad', bad);
    }
  };
  const raw = input.value.trim();
  if (!raw) {
    say('Paste a replay code first.', true);
    input.focus();
    return;
  }
  if (raw.length > 2_000_000) {
    say('That is too long to be a replay code.', true);
    return;
  }
  try {
    const replay = decodeReplay(raw);
    say(`Loaded a ${formatSize(raw.length)} replay.`, false);
    openViewer(replay, raw, opener);
  } catch (e) {
    say(e instanceof Error ? e.message : 'That replay code did not load.', true);
    input.focus();
  }
}

// ---------------------------------------------------------------------------
// Viewer

const TICKS_PER_SEC = 1 / DT;
const STEP_TICKS = 6;
const BIG_STEP_TICKS = 60;

const clock = (ticks: number) => {
  const s = Math.max(0, ticks) / TICKS_PER_SEC;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

export function openViewer(replay: Replay, code: string, opener: HTMLElement | null, startClip = 0): void {
  if (!appRoot) return;
  hideToast();
  const clips: Clip[] = clipsFor(replay);
  const seeker = new ReplaySeeker(replay);
  const el = document.createElement('div');
  el.className = 'replay-layer';
  const names = `${replay.home.name} ${replay.score[0]}, ${replay.away.name} ${replay.score[1]}`;
  el.innerHTML = `<div class="replay-card replay-viewer" role="dialog" aria-modal="true" aria-labelledby="rv-title">
    <header class="rp-head">
      <div class="rp-heading">
        <h2 id="rv-title" class="rp-title" tabindex="-1"></h2>
        <p id="rv-sub" class="small muted"></p>
      </div>
      <button class="btn small" data-rp="close" aria-keyshortcuts="Escape">Close</button>
    </header>
    <div class="rp-stage">
      <canvas id="rv-canvas" class="pitch-canvas replay-canvas" role="img" aria-label="Replay of the match"></canvas>
      <span class="rp-tag" aria-hidden="true">Replay</span>
      <span class="rp-word" aria-hidden="true" hidden>Replay</span>
    </div>
    <div class="rp-scrub">
      <label class="visually-hidden" for="rv-scrub">Replay position</label>
      <input id="rv-scrub" type="range" min="0" max="1" step="1" value="0">
      <span id="rv-time" class="rp-time" aria-hidden="true"></span>
    </div>
    <div class="rp-controls">
      <button class="btn" data-rp="prev" aria-keyshortcuts="PageUp">Previous</button>
      <button class="btn primary" data-rp="play" aria-keyshortcuts="Space">Play</button>
      <button class="btn" data-rp="next" aria-keyshortcuts="PageDown">Next</button>
      <button class="btn" data-rp="slow" aria-pressed="false" aria-keyshortcuts="S">½× slow-mo</button>
    </div>
    <p id="rv-status" class="small rp-status" role="status"></p>
    <div class="rp-foot">
      <button class="btn small ghost" data-rp="copy">Copy replay code</button>
      <span class="muted small">${formatSize(codeSize(code))}</span>
      <span class="muted small rp-keys">Space play · ← → step · Shift+← → second · PgUp PgDn goal · S slow-mo · Esc close</span>
    </div>
  </div>`;
  const q = <T extends HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
  const canvas = q<HTMLCanvasElement>('#rv-canvas');
  const scrub = q<HTMLInputElement>('#rv-scrub');
  const playBtn = q('[data-rp="play"]');
  const slowBtn = q('[data-rp="slow"]');
  const status = q('#rv-status');

  let idx = Math.min(Math.max(0, startClip), clips.length - 1);
  let clip = clips[idx];
  let playing = false;
  let slow = false;
  let acc = 0;
  let last = performance.now();
  let raf = 0;
  let dirty = true;
  let warmTimer = 0;
  let closed = false;
  let renderer: MatchRenderer | null = null;
  let wordTimer = 0;
  const motionOk = !reducedMotion();

  const layer: Layer = {
    el,
    opener,
    close: () => {
      if (closed) return;
      closed = true;
      cancelAnimationFrame(raf);
      clearTimeout(warmTimer);
      clearTimeout(wordTimer);
      ro.disconnect();
      renderer?.dispose();
      renderer = null;
      popLayer(layer);
    },
    onKey: (e) => {
      const t = e.target as HTMLElement;
      const typing = t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && t.type !== 'range');
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return false;
      const onButton = t instanceof HTMLButtonElement;
      switch (e.key) {
        case ' ':
          // A focused button handles Space itself.
          if (onButton) return false;
          togglePlay();
          return true;
        case 'ArrowLeft':
        case 'ArrowRight':
          nudge((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? BIG_STEP_TICKS : STEP_TICKS));
          return true;
        case 'PageUp':
          go(-1);
          return true;
        case 'PageDown':
          go(1);
          return true;
        case 's':
        case 'S':
          toggleSlow();
          return true;
        default:
          return false;
      }
    },
  };

  const pos = () => seeker.state.tick - clip.start;
  const len = () => clip.end - clip.start;

  function label(): string {
    return clip.kind === 'goal'
      ? `Goal ${clip.n} of ${replay.goals.length}: ${clip.goal!.scorer}, ${clip.goal!.minute}'`
      : 'Whole match';
  }

  function sync() {
    scrub.value = String(pos());
    q('#rv-time').textContent = `${clock(pos())} / ${clock(len())}`;
    scrub.setAttribute('aria-valuetext', `${clock(pos())} of ${clock(len())}`);
    const atEnd = seeker.state.tick >= clip.end;
    playBtn.textContent = playing ? 'Pause' : atEnd ? 'Replay' : 'Play';
    slowBtn.setAttribute('aria-pressed', String(slow));
    dirty = true;
  }

  function setClip(i: number, autoplay: boolean) {
    idx = (i + clips.length) % clips.length;
    clip = clips[idx];
    seeker.seek(clip.start);
    acc = 0;
    scrub.max = String(len());
    q('#rv-title').textContent = label();
    const g = clip.goal;
    q('#rv-sub').textContent = g
      ? `${replay.home.name} ${replay.score[0]}–${replay.score[1]} ${replay.away.name} · ${replay[g.team === 0 ? 'home' : 'away'].name} score`
      : `${replay.home.name} ${replay.score[0]}–${replay.score[1]} ${replay.away.name} · ${clips.length > 1 ? `${replay.goals.length} goal${replay.goals.length === 1 ? '' : 's'}` : 'no goals'}`;
    canvas.setAttribute('aria-label', `Replay: ${label()}. ${names}`);
    // Big "REPLAY" over the picture as each clip starts.
    const word = q('.rp-word');
    word.hidden = false;
    clearTimeout(wordTimer);
    wordTimer = window.setTimeout(() => (word.hidden = true), 1300);
    playing = autoplay && motionOk;
    sync();
    announce(`${label()}.`);
  }

  function togglePlay() {
    if (!playing && seeker.state.tick >= clip.end) {
      seeker.seek(clip.start);
      acc = 0;
    }
    playing = !playing;
    sync();
  }

  function toggleSlow() {
    slow = !slow;
    sync();
    announce(slow ? 'Half speed.' : 'Full speed.');
  }

  function nudge(delta: number) {
    playing = false;
    seeker.seek(Math.min(clip.end, Math.max(clip.start, seeker.state.tick + delta)));
    sync();
  }

  function go(d: number) {
    setClip(idx + d, true);
  }

  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-rp]');
    if (!b) return;
    switch (b.dataset.rp) {
      case 'close':
        layer.close();
        break;
      case 'play':
        togglePlay();
        break;
      case 'prev':
        go(-1);
        break;
      case 'next':
        go(1);
        break;
      case 'slow':
        toggleSlow();
        break;
      case 'copy':
        copyCode(code, b);
        break;
    }
  });
  scrub.addEventListener('input', () => {
    seeker.seek(clip.start + Number(scrub.value));
    acc = 0;
    sync();
  });

  const ro = new ResizeObserver(() => {
    renderer?.resize();
    dirty = true;
  });

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.2, (now - last) / 1000);
    last = now;
    if (playing) {
      acc += dt * (slow ? 0.5 : 1);
      let n = 0;
      while (acc >= DT && n < 12 && seeker.state.tick < clip.end) {
        seeker.stepForward();
        acc -= DT;
        n++;
      }
      if (n) {
        scrub.value = String(pos());
        q('#rv-time').textContent = `${clock(pos())} / ${clock(len())}`;
        dirty = true;
      }
      if (seeker.state.tick >= clip.end) {
        playing = false;
        sync();
      }
    }
    if ((dirty || renderer?.continuous) && renderer) {
      dirty = false;
      renderer.draw(seeker.state, { cursor: null, charge: 0, showCursor: false });
    }
  }

  // Background pass: fills every keyframe and checks the replay still ends where it did when it was played.
  function warm() {
    if (closed) return;
    const t0 = performance.now();
    let done = false;
    while (!done && performance.now() - t0 < 6) done = seeker.warm(60);
    if (!done) {
      warmTimer = window.setTimeout(warm, 0);
      return;
    }
    if (seeker.verified === false) {
      status.textContent = 'This replay was recorded on a different version of the game, so it may not match what happened.';
      status.classList.add('bad');
    }
    el.dataset.verified = String(seeker.verified);
  }

  pushLayer(layer);
  renderer = createMatchRenderer(canvas, { cinematic: true });
  renderer.resize();
  renderer.prepare(seeker.state);
  ro.observe(canvas);
  setClip(idx, true);
  q('#rv-title').focus();
  raf = requestAnimationFrame(frame);
  warmTimer = window.setTimeout(warm, 0);
  if (!motionOk) status.textContent = 'Reduced motion is on, so the replay will not play by itself. Press Play.';
}

// ---------------------------------------------------------------------------
// Wiring

/** Call once with #app. Handles every data-replay control inside it. */
export function initReplayUi(root: HTMLElement): void {
  appRoot = root;
  root.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-replay]');
    if (!el) return;
    const kind = el.dataset.replay;
    if (kind === 'paste') {
      const input = root.querySelector<HTMLInputElement>('#replay-paste');
      if (input) playPasted(input, el);
      return;
    }
    const found = recentReplays().find((r) => r.id === el.dataset.id) ?? (lastReplay()?.id === el.dataset.id ? lastReplay() : null);
    if (!found) {
      showToast('That replay is no longer stored.', false);
      return;
    }
    if (kind === 'copy') copyCode(found.code, el);
    else if (kind === 'watch') openViewer(found.replay, found.code, el);
  });
  root.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key === 'Enter' && t.id === 'replay-paste') {
      e.preventDefault();
      playPasted(t as HTMLInputElement, t);
    }
  });
}
