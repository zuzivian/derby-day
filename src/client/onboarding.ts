// First run, in as few steps as possible. A new club sees one welcome with one
// big Kick off and is playing its first match straight away (the coach tips in
// coach.ts teach the controls inside it). Afterwards a short celebration of the
// result and the first XP, then an optional, skippable chance to name the club
// and pick colours. Nothing else is asked up front: menus are revealed by club
// level (UNLOCKS in src/meta/levels.ts) and the training-ground drills are the
// optional "Practice skills" entry. Both screens render into #app while they run.

import type { ClubIdentity } from '../meta/club.ts';
import type { Save } from '../meta/game.ts';
import { NAME_MAX, NAME_MIN, renameClub, rerollColours, rerollName, validateClubName } from '../meta/identity.ts';
import { levelForXp, nextUnlockText, type XpGain } from '../meta/levels.ts';
import { announce, captureFocus, restoreFocus } from './a11y.ts';
import { crestSvg } from './crest.ts';
import { esc } from './ui.ts';

const ballIcon = `<svg class="icon" viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.2 15.6 9.8 14.2 14H9.8L8.4 9.8Z" fill="currentColor"/></svg>`;

const kit = (c: { primary: string; secondary: string }) =>
  `<span class="ob-kit" role="img" aria-label="Kit colours"><span style="background:${c.primary}"></span><span style="background:${c.secondary}"></span></span>`;

// ---------------------------------------------------------------------------
// Welcome: one click to a match

export interface WelcomeOptions {
  save: Save;
  /** The easy CPU club of the first match. */
  opp: ClubIdentity;
  /** Kick off: start the first match. */
  onKickOff: () => void;
  /** "I've played before": go to the club without the first-match flow. */
  onSkip: () => void;
}

export function mountWelcome(root: HTMLElement, o: WelcomeOptions): () => void {
  const c = o.save.club;
  root.innerHTML = `<div class="onboarding" data-onboarding>
    <header class="ob-top">
      <h1 class="wordmark">Derby Day</h1>
      <button class="btn small ghost" data-action="skip-onboarding" type="button">I've played before</button>
    </header>
    <main id="main" class="ob-main" tabindex="-1">
      <section class="panel ob-card ob-welcome" aria-labelledby="ob-title">
        <h2 id="ob-title" class="ob-title" tabindex="-1">Welcome, coach</h2>
        <p class="ob-lede">Run a football club and play every match yourself. Your first game is against ${esc(o.opp.name)}, a friendly one: about six minutes, and the coach will show you the controls as you go.</p>
        <div class="versus ob-versus">
          <div class="side">${crestSvg(c, 64)}<div class="side-name">${esc(c.name)}</div>${kit(c)}</div>
          <div class="vs" aria-hidden="true">vs</div>
          <div class="side">${crestSvg(o.opp, 64)}<div class="side-name">${esc(o.opp.name)}</div>${kit(o.opp)}</div>
        </div>
        <button class="kickoff" id="ob-kickoff" data-action="onboarding-kickoff" type="button">${ballIcon}<span>Kick off</span></button>
        <p class="muted small">You can rename your club afterwards.</p>
      </section>
    </main>
  </div>`;
  const onClick = (e: Event) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (el?.dataset.action === 'onboarding-kickoff') o.onKickOff();
    else if (el?.dataset.action === 'skip-onboarding') o.onSkip();
  };
  root.addEventListener('click', onClick);
  root.querySelector<HTMLElement>('#ob-kickoff')?.focus();
  return () => root.removeEventListener('click', onClick);
}

// ---------------------------------------------------------------------------
// After the first match: celebrate, then (optionally) name the club

/** The headline for the first result: warm whatever happened. */
export function celebrationWords(gf: number, ga: number): { title: string; sub: string } {
  if (gf > ga) return { title: 'What a start!', sub: 'You won your first match.' };
  if (gf === ga) return { title: 'Honours even', sub: 'A draw first time out is a fine start.' };
  return { title: 'Good effort', sub: 'Everyone loses a first game. Now you know the controls.' };
}

export interface AfterMatchOptions {
  save: Save;
  opp: ClubIdentity;
  gf: number;
  ga: number;
  xp: XpGain;
  persist: () => void;
  /** Naming is over (done or skipped): go to the club. */
  onDone: () => void;
}

type Step = 'celebrate' | 'club';

export function mountAfterMatch(root: HTMLElement, o: AfterMatchOptions): () => void {
  let step: Step = 'celebrate';
  let nameDraft = '';
  let nameError = '';
  let done = false;
  root.innerHTML = `<div class="onboarding" data-onboarding></div>`;
  const host = root.firstElementChild as HTMLElement;

  function body(): string {
    const c = o.save.club;
    if (step === 'celebrate') {
      const w = celebrationWords(o.gf, o.ga);
      const p = levelForXp(o.save.xp ?? 0);
      const pct = Math.min(100, Math.round((p.intoLevel / p.needed) * 100));
      const next = nextUnlockText(o.save);
      return `<section class="panel ob-card ob-celebrate" aria-labelledby="ob-title">
        <p class="eyebrow">Full time</p>
        <h2 id="ob-title" class="ob-title" tabindex="-1">${w.title}</h2>
        <div class="versus ob-versus">
          <div class="side">${crestSvg(c, 56)}<div class="side-name">${esc(c.name)}</div></div>
          <div class="ob-score" aria-label="Final score ${o.gf} to ${o.ga}"><span aria-hidden="true">${o.gf} – ${o.ga}</span></div>
          <div class="side">${crestSvg(o.opp, 56)}<div class="side-name">${esc(o.opp.name)}</div></div>
        </div>
        <p class="ob-lede">${w.sub}</p>
        <div class="ob-xp" aria-labelledby="ob-xp-title">
          <h3 id="ob-xp-title" class="eyebrow">Club level ${p.level}</h3>
          <p class="xp-gain"><b>+${o.xp.total} XP</b> <span class="muted">${o.xp.parts.map((x) => `${esc(x.label)} ${x.xp}`).join(' · ')}</span></p>
          <div class="ob-xp-bar" role="progressbar" aria-label="XP to the next level" aria-valuemin="0" aria-valuemax="${p.needed}" aria-valuenow="${Math.min(p.intoLevel, p.needed)}"><i style="width:${pct}%"></i></div>
          ${o.xp.levelAfter > o.xp.levelBefore ? `<p><b>Level ${o.xp.levelAfter}!</b> The club opens up as it levels.</p>` : ''}
          ${next ? `<p class="muted small">Next: ${esc(next)}.</p>` : ''}
        </div>
        <div class="ob-nav"><button class="btn ghost" data-ob="skip" type="button">Skip, go to the club</button><button class="btn primary big" data-ob="next" type="button">Name your club</button></div>
      </section>`;
    }
    return `<section class="panel ob-card" aria-labelledby="ob-title">
      <h2 id="ob-title" class="ob-title" tabindex="-1">Your club</h2>
      <p class="muted">The board picked a name and colours. Keep them, roll new ones, or type your own name.</p>
      <div class="ob-club">
        ${crestSvg(c, 88)}
        <div class="ob-club-text">
          <p class="ob-club-name">${esc(c.name)}</p>
          <p class="ob-club-meta"><span class="ob-short" aria-label="Short code ${esc(c.short.split('').join(' '))}">${esc(c.short)}</span>${kit(c)}</p>
        </div>
      </div>
      <div class="actions">
        <button class="btn small" data-ob="reroll-name" type="button">New name</button>
        <button class="btn small" data-ob="reroll-colours" type="button">New colours</button>
      </div>
      <form class="ob-name-form" data-ob-form="name" novalidate>
        <label for="ob-name">Or type your own name</label>
        <div class="ob-name-row">
          <input id="ob-name" name="club-name" type="text" autocomplete="off" spellcheck="false" maxlength="${NAME_MAX + 8}" value="${esc(nameDraft)}"
            aria-describedby="ob-name-hint${nameError ? ' ob-name-error' : ''}"${nameError ? ' aria-invalid="true"' : ''}>
          <button class="btn" data-ob="rename" type="submit">Use this name</button>
        </div>
        <p id="ob-name-hint" class="muted small">${NAME_MIN} to ${NAME_MAX} characters: letters, numbers, spaces and . ' - &amp;</p>
        ${nameError ? `<p id="ob-name-error" class="ob-error" role="alert">${esc(nameError)}</p>` : ''}
      </form>
      <div class="ob-nav"><button class="btn ghost" data-ob="skip" type="button">Skip</button><button class="btn primary big" data-ob="done" type="button">Go to the club</button></div>
    </section>`;
  }

  function render(focusTitle = false) {
    if (done) return;
    const key = focusTitle ? null : captureFocus(host);
    host.innerHTML = `
      <header class="ob-top"><h1 class="wordmark">Derby Day</h1></header>
      <main id="main" class="ob-main" tabindex="-1">${body()}</main>`;
    if (focusTitle) host.querySelector<HTMLElement>('#ob-title')?.focus();
    else restoreFocus(host, key);
  }

  function finish() {
    if (done) return;
    done = true;
    o.onDone();
  }

  host.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-ob]');
    if (!el) return;
    const s = o.save;
    switch (el.dataset.ob) {
      case 'next':
        step = 'club';
        render(true);
        window.scrollTo({ top: 0 });
        return;
      case 'reroll-name':
        rerollName(s);
        o.persist();
        render();
        announce(`New name: ${s.club.name}.`);
        return;
      case 'reroll-colours':
        rerollColours(s);
        o.persist();
        render();
        announce('New colours and crest.');
        return;
      case 'skip':
      case 'done':
        return finish();
    }
  });

  host.addEventListener('submit', (e) => {
    const form = e.target as HTMLFormElement;
    if (form.dataset.obForm !== 'name') return;
    e.preventDefault();
    nameDraft = form.querySelector<HTMLInputElement>('#ob-name')!.value;
    const check = validateClubName(nameDraft);
    if (!check.ok) {
      nameError = check.error;
      render();
      host.querySelector<HTMLInputElement>('#ob-name')?.focus();
      return;
    }
    nameError = '';
    nameDraft = '';
    renameClub(o.save, check.name);
    o.persist();
    render();
    host.querySelector<HTMLElement>('[data-ob="done"]')?.focus();
    announce(`Club renamed to ${o.save.club.name}, short code ${o.save.club.short.split('').join(' ')}.`);
  });

  host.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'ob-name') nameDraft = el.value;
  });

  render(true);
  return () => {
    done = true;
  };
}
