// Two-human friendlies. Nothing here touches Elo, money or training.
//
//   Local 2P       hot-seat on one keyboard (src/client/pads.ts for bindings),
//                  your club against a ladder club you pick.
//   Link two tabs  two tabs of this browser play each other over
//                  BroadcastChannel with deterministic lockstep
//                  (src/net/lockstep.ts). One hosts and shows a room code, the
//                  other joins with it. Only inputs cross between the tabs.
//   Online         the same lockstep match between two browsers anywhere,
//                  over the WebSocket relay (server/, docs/ONLINE.md). Shown
//                  only when a relay URL is configured (src/net/config.ts).
//                  The host gets a code and an invite link (?join=CODE).

import { cpuTeam, ladderSquad, type LadderClub } from '../meta/club.ts';
import { clubTeam, lineupReady, type Save } from '../meta/game.ts';
import type { CrestPattern } from '../meta/names.ts';
import { REPLAY_VERSION } from '../meta/replay.ts';
import { BroadcastTransport, broadcastSupport } from '../net/broadcast.ts';
import { inviteLink, relayConfig, type RelayConfig } from '../net/config.ts';
import { Lockstep, syncHash } from '../net/lockstep.ts';
import { PeerWatch } from '../net/presence.ts';
import { cleanCrest, cleanStart, cleanTeam, isOwnTeam } from '../net/validate.ts';
import { isLockstepMsg, matchFromStart, roomCode, cleanCode, type RoomMsg, type StartInfo, type WireMsg } from '../net/room.ts';
import { narrow, type Transport } from '../net/transport.ts';
import { netVersion, WebSocketTransport } from '../net/websocket.ts';
import { DT, SIM_VERSION } from '../sim/constants.ts';
import { matchMinute, possessionShare } from '../sim/match.ts';
import type { MatchState, TeamSetup } from '../sim/types.ts';
import { announce, trapTab } from './a11y.ts';
import { crestSvg } from './crest.ts';
import { mountJuice } from './fx.ts';
import { InputController } from './input.ts';
import { mountMatch } from './matchView.ts';
import { BINDINGS, HotseatInput } from './pads.ts';
import { HUMAN_COLORS } from './render.ts';
import { createMatchRenderer, mountCameraToggle } from './renderer.ts';
import { fallback2D, watchGfxLoss } from './gfxloss.ts';
import { hudMarkup, mountHud, refereeWord } from './hud.ts';
import { clearLastReplay } from './replayStore.ts';
import type { Prefs } from './store.ts';
import { esc, type ResultView } from './ui.ts';
import { onPageGone } from './pagegone.ts';

export interface VersusOptions {
  save: Save;
  prefs: Prefs;
  /** Away kit swap when the colours are too close (lives in main.ts). */
  avoidClash: (home: TeamSetup, away: TeamSetup) => TeamSetup;
  /** Called once: a result to show in the usual dialog, or null to go straight back to the club. */
  onDone: (result: ResultView | null) => void;
}

/** Input delay for linked play, in 60 Hz ticks. See docs/ROADMAP.md, "Multiplayer spike". */
export const DEFAULT_DELAY = 4;

const STYLE_ID = 'versus-style';
const CSS = `
.vs-setup { max-width: 760px; margin: 0 auto; }
.vs-setup h1 { margin: 0; font-family: var(--font-display); font-size: 34px; }
.vs-setup p { margin: 0; }
.vs-sides { display: grid; grid-template-columns: 1fr auto 1fr; gap: 12px; align-items: center; }
.vs-player { display: inline-flex; align-items: center; gap: 6px; font-weight: 700; }
.vs-dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; box-shadow: 0 0 0 2px rgba(0,0,0,.25); }
.vs-actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.vs-setup select, .vs-setup input { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1.5px solid var(--control-line); background: var(--surface); color: var(--ink); max-width: 100%; }
.link-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.link-col { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px dashed var(--line); border-radius: 8px; }
.link-col h2 { margin: 0; font-size: 16px; }
.link-code { font-family: var(--font-display); font-weight: 900; font-size: 44px; letter-spacing: .14em; color: var(--accent); }
.link-warn { color: var(--bad); font-weight: 600; }
.link-note { color: var(--warn); }
.net-stats { margin: 0; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; text-align: center; }
.net-banner { position: absolute; left: 50%; top: 14px; transform: translateX(-50%); z-index: 3; padding: 6px 12px; border-radius: 8px; background: rgba(15,21,19,.85); color: #fff; font-weight: 700; font-size: 14px; white-space: nowrap; }
.net-banner.lost { background: #8a5a00; }
.invite { display: flex; gap: 6px; align-items: stretch; flex-wrap: wrap; }
.invite input { flex: 1 1 220px; min-width: 0; font-size: 13px; }
.net-banner.bad { background: #b8322a; top: 40%; font-size: 18px; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; align-items: center; white-space: normal; text-align: center; }
@media (max-width: 640px) { .link-cols, .vs-sides { grid-template-columns: 1fr; } }
`;

function injectCss(): void {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = CSS;
  document.head.appendChild(st);
}

const clientSeed = () => Math.floor(Math.random() * 2 ** 31) | 0;
const dot = (team: 0 | 1) => `<span class="vs-dot" style="background:${HUMAN_COLORS[team]}" aria-hidden="true"></span>`;
const kbd = (t: string) => t.replace(/(Hold |Esc|Enter|Space|Left Shift|Right Shift|Arrow keys|W A S D|\b[FEP]\b|, \(comma\)|\. \(period\)|\/)/g, (k) => (k === 'Hold ' ? k : `<kbd>${k}</kbd>`));

function ownTeam(save: Save): TeamSetup | null {
  if (!lineupReady(save)) return null;
  return clubTeam(save, 0.6);
}

/** A result for the usual dialog, from `side`'s point of view. */
function resultFor(m: MatchState, side: 0 | 1, opp: ResultView['opp'], elo: number, label: string, note: string): ResultView {
  const o = side === 0 ? 1 : 0;
  const poss = possessionShare(m);
  const scorers = (team: 0 | 1) => m.goals.filter((e) => e.team === team).map((e) => `${e.scorer} ${e.minute}'`);
  return {
    ranked: false,
    forfeited: false,
    gf: m.score[side],
    ga: m.score[o],
    opp,
    summary: null,
    eloBefore: elo,
    eloAfter: elo,
    stats: [m.stats[side], m.stats[o]],
    possession: [poss[side], poss[o]],
    scorersFor: scorers(side),
    scorersAgainst: scorers(o),
    label,
    note,
    unrecorded: 'Friendly between two humans: no Elo, no money, no training.',
  };
}

const oppOf = (t: TeamSetup, crest: CrestPattern): ResultView['opp'] => ({ name: t.name, short: t.short, primary: t.primary, secondary: t.secondary, crest });

// ---------------------------------------------------------------------------
// Local 2P (hot-seat)

export function mountLocal2P(root: HTMLElement, o: VersusOptions): () => void {
  injectCss();
  let stopMatch: (() => void) | null = null;
  const home = ownTeam(o.save);
  const ladder = [...o.save.ladder].sort((a, b) => b.elo - a.elo);
  const near = [...ladder].sort((a, b) => Math.abs(a.elo - o.save.club.elo) - Math.abs(b.elo - o.save.club.elo))[0];
  root.innerHTML = `
  <section class="panel vs-setup" aria-labelledby="l2p-title">
    <h1 id="l2p-title" tabindex="-1">Local 2P friendly</h1>
    <p>Two players on one keyboard. Each of you steers one player of your team; the CPU runs everyone else. No Elo, no rewards.</p>
    <div class="vs-sides">
      <div class="side">${crestSvg(o.save.club, 56)}<div class="side-name">${esc(o.save.club.name)}</div><span class="vs-player">${dot(0)} Player 1 · yellow marker</span></div>
      <div class="vs">vs</div>
      <div class="side"><label class="vs-player" for="l2p-opp">${dot(1)} Player 2 · cyan marker</label>
        <select id="l2p-opp">${ladder.map((c) => `<option value="${esc(c.id)}"${c === near ? ' selected' : ''}>${esc(c.name)} (Elo ${c.elo})</option>`).join('')}</select>
      </div>
    </div>
    <table class="tbl compact"><thead><tr><th scope="col">Action</th><th scope="col">${dot(0)} Player 1</th><th scope="col">${dot(1)} Player 2</th></tr></thead>
      <tbody>${BINDINGS.map((b) => `<tr><th scope="row">${b.action}</th><td>${kbd(esc(b.p1))}</td><td>${kbd(esc(b.p2))}</td></tr>`).join('')}</tbody></table>
    ${home ? '' : '<p class="link-warn" role="alert">Pick a full XI in Squad first.</p>'}
    <div class="vs-actions">
      <button class="btn primary big" id="l2p-start"${home ? '' : ' disabled'}>Kick off</button>
      <button class="btn" id="l2p-back">Back to the club</button>
    </div>
  </section>`;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  $('l2p-title').focus();
  $('l2p-back').addEventListener('click', () => o.onDone(null));
  $('l2p-start').addEventListener('click', () => {
    const club = ladder.find((c) => c.id === $<HTMLSelectElement>('l2p-opp').value)!;
    start(club);
  });

  function start(club: LadderClub) {
    const squad = ladderSquad(club);
    const away = o.avoidClash(home!, cpuTeam(club, squad, 0.6));
    stopMatch = mountMatch(root, {
      seed: clientSeed(),
      home: home!,
      away,
      halfSeconds: o.prefs.halfSeconds,
      humans: [true, true],
      crests: [o.save.club.crest, club.crest],
      label: 'Local 2P',
      forfeitText: 'Leave match',
      controlsHint: `${dot(0)} <b>P1:</b> WASD · Space pass · hold F shoot · E switch · Left Shift sprint (or the mouse) &nbsp; ${dot(1)} <b>P2:</b> arrows · Enter or / pass · hold . shoot · , switch · Right Shift sprint · Esc pause`,
      inputSource: (canvas, renderer, s, togglePause) => {
        const pads = new HotseatInput(canvas, renderer, (team) => s.controlled[team] >= 0 && s.ball.owner === s.controlled[team], togglePause);
        return {
          take: () => pads.take(),
          reset: () => pads.reset(),
          extras: () => {
            // Where each human's player is, for tests and tooling (the canvas has no DOM for players).
            for (const t of [0, 1] as const) {
              const p = s.players[s.controlled[t]];
              canvas.dataset[`p${t + 1}`] = `${p.i},${p.pos.x.toFixed(2)},${p.pos.y.toFixed(2)}`;
            }
            const charges = pads.charges();
            return { cursor: pads.mouse ? pads.cursor : null, charge: charges[0], charges, showCursor: pads.mouse, team: 0 };
          },
          dispose: () => pads.dispose(),
        };
      },
      onEnd: (m, left) => {
        stopMatch?.();
        stopMatch = null;
        o.onDone(left ? null : resultFor(m, 0, oppOf(away, club.crest), o.save.club.elo, 'Local 2P', `Player 1 (yellow) ${m.score[0]}–${m.score[1]} Player 2 (cyan).`));
      },
    });
  }
  return () => stopMatch?.();
}

// ---------------------------------------------------------------------------
// Link two tabs: lobby

const peerId = () => Math.random().toString(36).slice(2, 10);

export function mountLink(root: HTMLElement, o: VersusOptions): () => void {
  injectCss();
  const support = broadcastSupport();
  const home = ownTeam(o.save);
  let transport: BroadcastTransport<WireMsg> | null = null;
  let timers: ReturnType<typeof setInterval>[] = [];
  let stopMatch: (() => void) | null = null;
  let closed = false;

  root.innerHTML = `
  <section class="panel vs-setup" aria-labelledby="link-title" id="link-lobby">
    <h1 id="link-title" tabindex="-1">Link two tabs</h1>
    <p>A friendly between two tabs or windows of this browser. One tab hosts and shows a code; in the other, open the club, choose <b>Link two tabs</b> and join with that code. Each tab steers its own team, and the tabs exchange only inputs: both run the same deterministic match in lockstep. No Elo, no rewards.</p>
    ${support.ok ? (support.note ? `<p class="link-note">${esc(support.note)}</p>` : '') : `<p class="link-warn" id="link-unsupported" role="alert">${esc(support.reason)}</p>`}
    ${home ? '' : '<p class="link-warn" role="alert">Pick a full XI in Squad first.</p>'}
    <div class="link-cols">
      <div class="link-col">
        <h2>Host</h2>
        <label>Input delay <select id="link-delay">${[2, 3, 4, 5, 6, 8].map((d) => `<option value="${d}"${d === DEFAULT_DELAY ? ' selected' : ''}>${d} ticks (${Math.round((d * 1000) / 60)} ms)</option>`).join('')}</select></label>
        <button class="btn primary" id="link-host"${support.ok && home ? '' : ' disabled'}>Host a match</button>
        <div class="link-code" id="link-code" aria-live="polite" hidden></div>
      </div>
      <div class="link-col">
        <h2>Join</h2>
        <label>Room code <input id="link-code-input" maxlength="8" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text"></label>
        <button class="btn primary" id="link-join"${support.ok && home ? '' : ' disabled'}>Join</button>
      </div>
    </div>
    <p id="link-status" role="status" aria-live="polite"></p>
    <div class="vs-actions"><button class="btn" id="link-back">Back to the club</button></div>
    <p class="muted small">Tip: put the two windows side by side. A hidden tab keeps playing, but only while the other tab is sending.</p>
  </section>`;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const status = (t: string, bad = false) => {
    const el = $('link-status');
    el.textContent = t;
    el.className = bad ? 'link-warn' : '';
  };
  $('link-title').focus();

  const cleanupLobby = () => {
    for (const t of timers) clearInterval(t);
    timers = [];
  };
  const leave = () => {
    if (closed) return;
    closed = true;
    cleanupLobby();
    transport?.close();
    o.onDone(null);
  };
  $('link-back').addEventListener('click', leave);

  $('link-host').addEventListener('click', () => {
    if (transport || !home) return;
    const code = roomCode(Math.random);
    const id = peerId();
    const delay = Number($<HTMLSelectElement>('link-delay').value) || DEFAULT_DELAY;
    const tr = (transport = new BroadcastTransport<WireMsg>(code, id));
    $('link-code').textContent = code;
    $('link-code').hidden = false;
    $<HTMLButtonElement>('link-host').disabled = true;
    $<HTMLButtonElement>('link-join').disabled = true;
    status(`Waiting for the other tab to join with code ${code}…`);
    let start: StartInfo | null = null;
    let guest: string | null = null;
    const seed = clientSeed();
    const off = tr.onMessage((m) => {
      if (m.t === 'join' && typeof m.id === 'string' && (!guest || guest === m.id)) {
        start ??= hostStart(o, home, m, seed, delay);
        if (!start) return;
        guest = m.id;
        tr.send({ t: 'start', to: guest, host: id, start });
        status('Guest found. Starting…');
      } else if (m.t === 'ready' && m.id === guest && start) {
        off();
        tr.peer = guest;
        launch(tr, start, 0);
      }
    });
  });

  $('link-join').addEventListener('click', () => {
    if (transport || !home) return;
    const code = cleanCode($<HTMLInputElement>('link-code-input').value);
    if (code.length < 4) {
      status('Type the 4-letter code shown in the host tab.', true);
      return;
    }
    const id = peerId();
    const tr = (transport = new BroadcastTransport<WireMsg>(code, id));
    $<HTMLButtonElement>('link-host').disabled = true;
    $<HTMLButtonElement>('link-join').disabled = true;
    status(`Looking for host ${code}…`);
    let started = false;
    const off = tr.onMessage((m) => {
      if (m.t !== 'start' || m.to !== id || started) return;
      const st = cleanStart(m.start);
      const mine = cleanTeam(home);
      // The host builds both teams: ours must still be ours (only the kit and a " II" may change).
      if (!st || !mine || !isOwnTeam(st.away, mine) || typeof m.host !== 'string') return;
      started = true;
      off();
      cleanupLobby();
      tr.peer = m.host;
      launch(tr, st, 1);
      tr.send({ t: 'ready', id });
    });
    const join = () => tr.send({ t: 'join', id, team: home, crest: o.save.club.crest });
    join();
    const t0 = performance.now();
    timers.push(
      setInterval(() => {
        if (started) return;
        if (performance.now() - t0 > 6000) {
          cleanupLobby();
          off();
          tr.close();
          transport = null;
          $<HTMLButtonElement>('link-host').disabled = false;
          $<HTMLButtonElement>('link-join').disabled = false;
          status(
            `No host answered on code ${code}. Check the code, and that the host tab is this same page (same file or address) in the same browser. Embedded viewers can block tabs from talking; if so, open dist/index.html directly in two tabs.`,
            true,
          );
          return;
        }
        join();
      }, 500),
    );
  });

  function launch(tr: BroadcastTransport<WireMsg>, start: StartInfo, side: 0 | 1) {
    cleanupLobby();
    stopMatch = mountNetMatch(root, {
      start,
      side,
      transport: tr,
      controls: o.prefs.controls,
      onEnd: (m, end) => {
        stopMatch = null;
        closed = true;
        tr.close();
        o.onDone(netResult(m, end, start, side, o, 'Linked friendly'));
      },
    });
  }

  return () => {
    closed = true;
    cleanupLobby();
    stopMatch?.();
    transport?.close();
  };
}

/** The result dialog for a finished or abandoned two-human match (null: straight back to the club). */
function netResult(m: MatchState, end: NetEnd, start: StartInfo, side: 0 | 1, o: VersusOptions, label: string): ResultView | null {
  clearLastReplay(); // linked and online matches aren't recorded; don't offer the previous replay
  if (end === 'left') return null;
  const opp = side === 0 ? oppOf(start.away, start.crests[1]) : oppOf(start.home, start.crests[0]);
  if (end === 'abandoned') {
    const note = `Your opponent disconnected and did not come back within 20 seconds. Stopped at ${start.home.short} ${m.score[0]}–${m.score[1]} ${start.away.short}, minute ${matchMinute(m)}.`;
    return { ...resultFor(m, side, opp, o.save.club.elo, label, note), abandoned: true, unrecorded: 'Abandoned friendly: no result, no Elo, no money, no training.' };
  }
  const hash = syncHash(m).toString(16).padStart(8, '0');
  const note = `Final ${start.home.short} ${m.score[0]}–${m.score[1]} ${start.away.short} at tick ${m.tick}, state #${hash}. Input delay ${start.delay} ticks.`;
  return resultFor(m, side, opp, o.save.club.elo, label, note);
}

/**
 * The host's half of the room handshake: answer a guest's join with the start info, or null when the
 * guest's team isn't well-formed. The guest's team is untrusted (it ends up in the page and in the sim),
 * and the whole start goes through cleanStart() on both sides so both build exactly the same match.
 */
function hostStart(o: VersusOptions, home: TeamSetup, m: Extract<RoomMsg, { t: 'join' }>, seed: number, delay: number): StartInfo | null {
  const theirs = cleanTeam(m.team);
  if (!theirs) return null;
  let away = o.avoidClash(home, theirs);
  if (away.name === home.name) away = { ...away, name: `${away.name} II` };
  return cleanStart({ seed, home, away, crests: [o.save.club.crest, cleanCrest(m.crest)], halfSeconds: o.prefs.halfSeconds, delay });
}

// ---------------------------------------------------------------------------
// Online: two browsers over the relay

export interface OnlineOptions extends VersusOptions {
  /** From an invite link (?join=CODE): join this code straight away. */
  joinCode?: string;
}

/** The online lobby, or a note that no relay is configured. */
export function mountOnline(root: HTMLElement, o: OnlineOptions): () => void {
  injectCss();
  const cfg = relayConfig();
  const home = ownTeam(o.save);
  let link: WebSocketTransport<WireMsg> | null = null;
  let offLink: (() => void)[] = [];
  let timers: ReturnType<typeof setInterval>[] = [];
  let stopMatch: (() => void) | null = null;
  let closed = false;
  const version = netVersion(SIM_VERSION, REPLAY_VERSION);

  root.innerHTML = `
  <section class="panel vs-setup" aria-labelledby="online-title" id="online-lobby">
    <h1 id="online-title" tabindex="-1">Online friendly</h1>
    <p>Play a friend on another computer. Create a match and send them the link (or the code); they open it and you kick off. Each of you steers your own team and only inputs cross the network. No Elo, no rewards.</p>
    ${cfg ? '' : '<p class="link-warn" role="alert" id="online-off">Online play is not switched on for this copy of the game.</p>'}
    ${home ? '' : '<p class="link-warn" role="alert">Pick a full XI in Squad first.</p>'}
    <div class="link-cols">
      <div class="link-col">
        <h2>Invite a friend</h2>
        <label>Input delay <select id="online-delay">${[3, 4, 5, 6, 8].map((d) => `<option value="${d}"${d === DEFAULT_DELAY ? ' selected' : ''}>${d} ticks (${Math.round((d * 1000) / 60)} ms)</option>`).join('')}</select></label>
        <button class="btn primary" id="online-host"${cfg && home ? '' : ' disabled'}>Create a match</button>
        <div class="link-code" id="online-code" aria-live="polite" hidden></div>
        <div class="invite" id="online-invite" hidden>
          <input id="online-link" readonly aria-label="Invite link">
          <button class="btn" id="online-copy">Copy link</button>
          ${typeof navigator !== 'undefined' && 'share' in navigator ? '<button class="btn" id="online-share">Share</button>' : ''}
        </div>
      </div>
      <div class="link-col">
        <h2>Join a friend</h2>
        <label>Match code <input id="online-code-input" maxlength="8" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" value="${esc(o.joinCode ?? '')}"></label>
        <button class="btn primary" id="online-join"${cfg && home ? '' : ' disabled'}>Join</button>
      </div>
    </div>
    <p id="online-status" role="status" aria-live="polite"></p>
    <div class="vs-actions"><button class="btn" id="online-back">Back to the club</button></div>
    <p class="muted small">Best on a wired or strong Wi-Fi connection, with both of you in the same region. If the connection drops, the match pauses for up to 20 seconds while it reconnects.</p>
  </section>`;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const lobby = $('online-lobby');
  const status = (t: string, bad = false, state = '') => {
    const el = $('online-status');
    el.textContent = t;
    el.className = bad ? 'link-warn' : '';
    lobby.dataset.state = state;
  };
  const buttons = (enabled: boolean) => {
    $<HTMLButtonElement>('online-host').disabled = !enabled || !cfg || !home;
    $<HTMLButtonElement>('online-join').disabled = !enabled || !cfg || !home;
  };
  $('online-title').focus();

  const cleanup = () => {
    for (const t of timers) clearInterval(t);
    timers = [];
    for (const f of offLink) f();
    offLink = [];
  };
  /** Back to the lobby's start, keeping the message on screen. */
  const reset = () => {
    cleanup();
    link?.close();
    link = null;
    $('online-code').hidden = true;
    $('online-invite').hidden = true;
    $('online-host').hidden = false;
    buttons(true);
  };
  const leave = () => {
    if (closed) return;
    closed = true;
    cleanup();
    link?.close();
    o.onDone(null);
  };
  $('online-back').addEventListener('click', leave);
  $('online-copy').addEventListener('click', async () => {
    const input = $<HTMLInputElement>('online-link');
    try {
      await navigator.clipboard.writeText(input.value);
      status('Link copied. Send it to your friend; this page waits for them.', false, lobby.dataset.state);
    } catch {
      input.select();
    }
  });
  root.querySelector('#online-share')?.addEventListener('click', () => {
    navigator.share?.({ title: 'Derby Day', text: `Play me at Derby Day: code ${link?.code ?? ''}`, url: $<HTMLInputElement>('online-link').value }).catch(() => {});
  });

  /** A relay link plus the handlers every lobby state shares. */
  function connect(c: RelayConfig, role: { host: true } | { join: string }): WebSocketTransport<WireMsg> {
    const tr = (link = new WebSocketTransport<WireMsg>({ url: c.url, version, role }));
    if ((globalThis as { __e2e?: boolean }).__e2e) (globalThis as { __derbyNet?: unknown }).__derbyNet = tr;
    offLink.push(
      tr.onEvent((e) => {
        if (stopMatch || closed) return;
        if (e.type === 'error') {
          status(e.msg, true, e.code);
          reset();
        } else if (e.type === 'peer' && e.s === 'left') {
          status('Your friend left before kick-off.', true, 'peer-left');
          reset();
        }
      }),
    );
    return tr;
  }

  $('online-host').addEventListener('click', () => {
    if (link || !home || !cfg) return;
    buttons(false);
    const delay = Number($<HTMLSelectElement>('online-delay').value) || DEFAULT_DELAY;
    const tr = connect(cfg, { host: true });
    status('Connecting to the match server…', false, 'connecting');
    const seed = clientSeed();
    let start: StartInfo | null = null;
    /** The guest we answered: only its ready starts the match. */
    let guestId: string | null = null;
    offLink.push(
      tr.onEvent((e) => {
        if (e.type === 'room' && !start) {
          const url = inviteLink(e.code, cfg);
          $('online-code').textContent = e.code;
          $('online-code').hidden = false;
          $('online-host').hidden = true;
          $<HTMLInputElement>('online-link').value = url;
          $('online-invite').hidden = false;
          status(`Send your friend the link or the code ${e.code}. Waiting for them to join…`, false, 'waiting');
        } else if (e.type === 'peer' && e.s === 'joined') status('Friend connected. Setting up the match…', false, 'pairing');
      }),
      tr.onMessage((m) => {
        if (m.t === 'join' && typeof m.id === 'string' && (guestId === null || guestId === m.id)) {
          start ??= hostStart(o, home, m, seed, delay);
          if (!start) {
            status("Your friend's team couldn't be read. Ask them to reload the page and try again.", true, 'bad-team');
            return;
          }
          guestId = m.id;
          tr.send({ t: 'start', to: m.id, host: 'host', start });
        } else if (m.t === 'ready' && start && m.id === guestId) launch(tr, start, 0);
      }),
    );
  });

  const join = () => {
    if (link || !home || !cfg) return;
    const code = cleanCode($<HTMLInputElement>('online-code-input').value);
    if (code.length < 4) {
      status('Type the code your friend sees on their screen.', true, 'bad-code');
      return;
    }
    buttons(false);
    const id = peerId();
    const tr = connect(cfg, { join: code });
    status(`Joining ${code}…`, false, 'connecting');
    let started = false;
    const hello = () => tr.send({ t: 'join', id, team: home, crest: o.save.club.crest });
    offLink.push(
      tr.onEvent((e) => {
        if (e.type !== 'room' || started) return;
        status('Connected. Waiting for the match to start…', false, 'pairing');
        hello();
        timers.push(setInterval(() => !started && hello(), 700));
      }),
      tr.onMessage((m) => {
        if (m.t !== 'start' || m.to !== id || started) return;
        const st = cleanStart(m.start);
        const mine = cleanTeam(home);
        if (!st || !mine) {
          status("The host's match couldn't be read. Both of you reload the page, then try again.", true, 'bad-start');
          return;
        }
        // The host builds both teams: ours must still be ours (only the kit and a " II" may change).
        if (!isOwnTeam(st.away, mine)) {
          status("The host's match didn't have your squad in it, so it wasn't started. Both of you reload the page, then try again.", true, 'bad-squad');
          return;
        }
        started = true;
        launch(tr, st, 1);
        tr.send({ t: 'ready', id });
      }),
    );
  };
  $('online-join').addEventListener('click', join);

  function launch(tr: WebSocketTransport<WireMsg>, start: StartInfo, side: 0 | 1) {
    cleanup();
    stopMatch = mountNetMatch(root, {
      start,
      side,
      transport: tr,
      link: tr,
      label: 'Online',
      controls: o.prefs.controls,
      onEnd: (m, end) => {
        stopMatch = null;
        closed = true;
        tr.close();
        o.onDone(netResult(m, end, start, side, o, 'Online friendly'));
      },
    });
  }

  if (o.joinCode && cfg && home) join();

  return () => {
    closed = true;
    cleanup();
    stopMatch?.();
    link?.close();
  };
}

// ---------------------------------------------------------------------------
// Linked and online matches

/** How a two-human match ended: full-time, someone left (or desync), or the opponent never came back. */
type NetEnd = 'full' | 'left' | 'abandoned';

interface NetMatchOptions {
  start: StartInfo;
  side: 0 | 1;
  transport: Transport<WireMsg>;
  /** The relay link, for online matches: its status and peer notices feed the disconnect countdown. */
  link?: WebSocketTransport<WireMsg>;
  /** Scoreboard label. */
  label?: string;
  controls: Prefs['controls'];
  onEnd: (s: MatchState, end: NetEnd) => void;
}

const FRAME_MS = DT * 1000;
/** Show "waiting for opponent" only after this long, so single late frames don't flicker it. */
const WAIT_BANNER_MS = 250;

function mountNetMatch(root: HTMLElement, o: NetMatchOptions): () => void {
  const s = matchFromStart(o.start);
  const [home, away] = s.teams;
  const me = o.side;
  const delayMs = Math.round(o.start.delay * FRAME_MS);
  const label = o.label ?? 'Linked';
  root.innerHTML = `
  <section class="match" aria-label="${label} match" id="net-match" data-side="${me}" data-mode="${o.link ? 'online' : 'tabs'}">
    <div class="pitch-wrap">
      <canvas id="pitch" tabindex="0" role="application" aria-roledescription="pitch" aria-label="Pitch. You control the ${me === 0 ? 'home side, yellow marker' : 'away side, cyan marker'}. Mouse or keys as usual; Esc opens the leave menu."></canvas>
      ${hudMarkup({ teams: [home, away], crests: o.start.crests, mode: 'You vs Friend', label, menuId: 'net-menu-btn', menuText: 'Menu' })}
      <div class="net-banner" id="net-wait" role="status" hidden>Waiting for opponent…</div>
      <div class="net-banner bad" id="net-stop" role="alert" hidden><span id="net-stop-text"></span><button class="btn" id="net-stop-back">Back to the club</button></div>
      <div class="pause" id="net-menu" hidden>
        <div class="pause-card" role="dialog" aria-modal="true" aria-labelledby="net-menu-title">
          <h2 id="net-menu-title">${label} match</h2>
          <p class="hint">The match keeps running: there is no pause online.</p>
          <div class="pause-actions">
            <button class="btn primary" id="net-resume">Keep playing</button>
            <button class="btn" id="net-leave">Leave match</button>
          </div>
        </div>
      </div>
    </div>
    <p class="net-stats" id="net-stats"></p>
    <p class="controls-hint">You are <b>${me === 0 ? 'Home' : 'Away'}</b> ${dot(me)} (${me === 0 ? 'yellow' : 'cyan'} marker). Same controls as a normal match: the pointer or WASD/arrows to run, left click or Space to pass, hold left or C to loft, right click or F to shoot.</p>
  </section>`;
  const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  const section = $('net-match');
  // let: a lost WebGL context that never comes back swaps both for a fresh 2D canvas (see gfx below).
  let canvas = root.querySelector<HTMLCanvasElement>('#pitch')!;
  let renderer = createMatchRenderer(canvas);
  const ls = new Lockstep({ state: s, side: me, transport: narrow(o.transport, isLockstepMsg), delay: o.start.delay, now: () => performance.now() });

  let menuOpen = false;
  let ended = false;
  const setMenu = (v: boolean) => {
    if (ended || menuOpen === v) return;
    menuOpen = v;
    $('net-menu').hidden = !v;
    (v ? $('net-resume') : canvas).focus();
  };
  const makeInput = () => {
    const c = new InputController(canvas, renderer, () => s.controlled[me] >= 0 && s.ball.owner === s.controlled[me], () => setMenu(!menuOpen));
    c.mode = o.controls;
    return c;
  };
  let input = makeInput();
  $('net-menu-btn').addEventListener('click', () => setMenu(true));
  $('net-resume').addEventListener('click', () => setMenu(false));
  $('net-leave').addEventListener('click', () => {
    ls.leave();
    finish('left');
  });
  $('net-stop-back').addEventListener('click', () => finish('left'));
  const onKey = (e: KeyboardEvent) => menuOpen && trapTab($('net-menu'), e);
  document.addEventListener('keydown', onKey);
  // Back from the back-forward cache (or a phone app switch): reconnect now rather than after the backoff.
  const onShow = (e: PageTransitionEvent) => {
    if (e.persisted) o.link?.reconnectNow();
  };
  window.addEventListener('pageshow', onShow);
  const onHide = (e: PageTransitionEvent) => {
    // persisted: the page may come back (the back-forward cache; mobile browsers switching apps).
    // Don't end the match for the opponent then: the disconnect countdown covers it if we don't return.
    if (e.persisted) return;
    ls.leave();
    o.link?.close(); // the relay tells the opponent at once too
  };
  window.addEventListener('pagehide', onHide);
  // After onHide: stop drawing and give the GPU back as the tab closes (dispose loses the context).
  const offGone = onPageGone(() => {
    if (ended) return;
    ended = true;
    dispose();
  });

  const ro = new ResizeObserver(() => renderer.resize());
  ro.observe(canvas);
  renderer.resize();
  renderer.prepare(s);
  const juice = mountJuice(root, s);
  // One player on this screen: only his own kick-off gets the prompt.
  const hud = mountHud(root.querySelector<HTMLElement>('.pitch-wrap')!, s, (team) => (team === me ? 'Your kick-off: click or press Space' : null));
  let offCam = mountCameraToggle(root.querySelector<HTMLElement>('.hud-tr')!, renderer);
  // WebGL context loss (gfxloss.ts): a lockstep match can't pause (the other tab plays on), so the note
  // covers the pitch while it runs; if the context doesn't come back, carry on in 2D.
  const gfx = watchGfxLoss(renderer, root.querySelector<HTMLElement>('.pitch-wrap')!, {
    onGiveUp: () => {
      if (ended) return;
      const mode = input.mode;
      input.dispose();
      offCam();
      ro.unobserve(canvas);
      ({ canvas, renderer } = fallback2D(canvas, renderer));
      input = makeInput();
      input.mode = mode;
      offCam = () => {};
      ro.observe(canvas);
      renderer.resize();
      renderer.prepare(s);
      announce('The graphics could not be restored, so the match carries on in the 2D view.');
    },
  });

  /** Stopped with a message (desync, the opponent left, the link died): the match no longer moves. */
  let halted = false;
  const stop = (text: string) => {
    if (ended || halted) return;
    halted = true;
    $('net-wait').hidden = true;
    $('net-stop-text').textContent = text;
    $('net-stop').hidden = false;
    section.dataset.stopped = text;
    announce(text);
    $('net-stop-back').focus();
  };
  ls.onDesync = (d) => {
    section.dataset.desync = String(d.tick);
    stop(`Desync at tick ${d.tick}: the two tabs no longer agree on the match (#${d.mine.toString(16)} vs #${d.theirs.toString(16)}). Stopped.`);
  };
  ls.onPeerLeft = () => stop('Your opponent left the match.');
  const offLink = o.link
    ? o.link.onEvent((e) => {
        if (e.type === 'peer' && e.s === 'left' && ls.running) stop('Your opponent left the match.');
        else if (e.type === 'error' && ls.running) stop(e.msg);
      })
    : () => {};
  // Disconnects: lockstep already pauses both sides; this decides when to say so, and when to give up.
  const watch = new PeerWatch();
  const abandon = () => {
    ls.leave();
    finish('abandoned');
  };
  // End-to-end tests (window.__e2e) read the state hash every 60 ticks to compare the two sides.
  const e2eHashes = (globalThis as { __e2e?: boolean }).__e2e ? new Map<number, string>() : null;
  if (e2eHashes) (globalThis as { __derbyNetHashes?: Map<number, string> }).__derbyNetHashes = e2eHashes;

  // Fixed-step pump. It runs from requestAnimationFrame, from every message
  // the peer sends (so a hidden tab, which gets no animation frames, still
  // keeps up), and from a slow timer as a fallback.
  let last = performance.now();
  let acc = 0;
  let stallStart: number | null = null;
  let stalledMs = 0;
  let longestStall = 0;
  let stallEvents = 0;
  const startedAt = performance.now();
  function pump() {
    if (ended || halted || !ls.running) return;
    const now = performance.now();
    acc += Math.min(250, now - last);
    last = now;
    let steps = 0;
    let stalled = false;
    while (acc >= FRAME_MS && steps < 12) {
      if (!ls.tick(() => input.take())) {
        stalled = true;
        acc = Math.min(acc, FRAME_MS);
        break;
      }
      juice.tick(s);
      if (e2eHashes && s.tick % 60 === 0) e2eHashes.set(s.tick, syncHash(s).toString(16));
      acc -= FRAME_MS;
      steps++;
    }
    if (steps) section.dataset.tick = String(s.tick);
    if (stalled) {
      if (stallStart === null) {
        stallStart = now;
        stallEvents++;
      }
    } else if (steps && stallStart !== null) {
      const d = now - stallStart;
      stalledMs += d;
      longestStall = Math.max(longestStall, d);
      stallStart = null;
    }
  }
  const offMsg = o.transport.onMessage(() => pump());
  const timer = setInterval(pump, 100);

  let raf = 0;
  let lastGoals = 0;
  let lastEvent = 0;
  let bannerUntil = 0;
  let shownHalftime = false;
  let fullAt = 0;
  let statsAt = 0;
  function banner(text: string, ms: number, sub?: string) {
    hud.word(text, ms, sub);
    bannerUntil = performance.now() + ms;
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    pump();
    renderer.draw(s, { cursor: input.cursor, charge: input.charge(), showCursor: input.mode === 'mouse', armed: input.armed(), team: me });
    hud.update(s, input.charge());
    $('sb-h').textContent = String(s.score[0]);
    $('sb-a').textContent = String(s.score[1]);
    $('sb-min').textContent = `${matchMinute(s)}'`;
    $('sb-phase').textContent = s.phase === 'halftime' ? 'Half-time' : s.phase === 'fulltime' ? 'Full-time' : `${label} · ${s.half === 1 ? '1st' : '2nd'} half`;
    const link = o.link;
    const live = ls.running && !halted;
    const pres = live ? watch.update({ now, stalled: ls.stalled, lastHeardAt: ls.lastHeardAt, away: !!link && (link.peer === 'away' || link.status === 'reconnecting') }) : { state: 'ok' as const };
    if (pres.state === 'abandoned') {
      abandon();
      return;
    }
    const lost = pres.state === 'lost' ? Math.ceil(pres.remainingMs / 1000) : 0;
    const waiting = lost > 0 || (stallStart !== null && now - stallStart > WAIT_BANNER_MS && live);
    const waitEl = $('net-wait');
    waitEl.hidden = !waiting;
    const waitText = lost ? (link?.status === 'reconnecting' ? `Connection lost, reconnecting… ${lost} s` : `Opponent disconnected, waiting ${lost} s`) : 'Waiting for opponent…';
    if (waitEl.textContent !== waitText) waitEl.textContent = waitText;
    waitEl.classList.toggle('lost', lost > 0);
    section.dataset.lost = String(lost);
    section.dataset.tick = String(s.tick);
    section.dataset.waiting = waiting ? '1' : '0';
    if (now - statsAt > 250) {
      statsAt = now;
      const stallNow = stallStart !== null ? now - stallStart : 0;
      const elapsed = Math.max(1, now - startedAt);
      section.dataset.stallMs = String(Math.round(stalledMs + stallNow));
      section.dataset.longestStallMs = String(Math.round(Math.max(longestStall, stallNow)));
      section.dataset.stallEvents = String(stallEvents);
      section.dataset.rttMs = ls.rttMs.toFixed(2);
      section.dataset.checks = String(ls.checksPassed);
      if (link) section.dataset.link = link.status;
      $('net-stats').textContent = `${link ? `${link.status === 'open' ? 'Online' : link.status} · ` : ''}Tick ${s.tick} · input delay ${o.start.delay} ticks (${delayMs} ms) · round trip ${ls.rttMs.toFixed(1)} ms · waited ${Math.round(((stalledMs + stallNow) / elapsed) * 100)}% of the time · in sync ×${ls.checksPassed}`;
    }

    while (lastEvent < s.events.length) {
      const w = refereeWord(s, s.events[lastEvent++]);
      if (w?.live) hud.tag(w.word, 1800, w.sub);
      else if (w) banner(w.word, 1500, w.sub);
    }
    if (s.goals.length > lastGoals) {
      const ev = s.goals[s.goals.length - 1];
      lastGoals = s.goals.length;
      banner('Goal!', 2000, `${ev.scorer} ${ev.minute}'`);
      announce(`Goal for ${s.teams[ev.team].name}. ${ev.scorer}, minute ${ev.minute}.`);
    }
    if (s.phase === 'halftime' && !shownHalftime) {
      shownHalftime = true;
      banner('Half time', 1800);
    }
    if (bannerUntil && now > bannerUntil) bannerUntil = 0;
    if (s.phase === 'fulltime' && !ls.desync && !ended) {
      if (!fullAt) {
        fullAt = now;
        banner('Full time', 99999);
        announce(`Full-time. ${home.name} ${s.score[0]}, ${away.name} ${s.score[1]}.`);
      }
      // Give the final state hash a moment to arrive from the other tab and be compared.
      if (now - fullAt > 1500) finish('full');
    }
  }
  raf = requestAnimationFrame(frame);
  canvas.focus({ preventScroll: true });
  announce(`${label} match. ${home.name} against ${away.name}. You are ${me === 0 ? 'home' : 'away'}.`);

  function dispose() {
    cancelAnimationFrame(raf);
    clearInterval(timer);
    offMsg();
    offLink();
    ls.dispose();
    input.dispose();
    gfx.dispose();
    juice.dispose();
    hud.dispose();
    offCam();
    ro.disconnect();
    renderer.dispose();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('pageshow', onShow);
    offGone();
  }
  function finish(end: NetEnd) {
    if (ended) return;
    ended = true;
    dispose();
    o.onEnd(s, end);
  }
  return () => {
    if (ended) return;
    ended = true;
    ls.leave();
    dispose();
  };
}
