// First-run setup: welcome, your club, controls, the training ground, and
// the first fixture. Skippable at every step. Renders into #app while it runs.

import { toTeamSetup, type LadderClub } from '../meta/club.ts';
import type { Save } from '../meta/game.ts';
import { NAME_MAX, NAME_MIN, renameClub, rerollColours, rerollName, validateClubName } from '../meta/identity.ts';
import { announce, captureFocus, restoreFocus } from './a11y.ts';
import { controlsCard } from './controls.ts';
import { crestSvg } from './crest.ts';
import type { ControlStyle, Prefs } from './store.ts';
import { mountTutorial } from './tutorial.ts';
import { esc } from './ui.ts';

export interface OnboardingOptions {
  save: Save;
  prefs: Prefs;
  nextOpp: LadderClub;
  persist: () => void;
  savePrefs: () => void;
  /** Setup is over, finished or skipped. The caller marks it done and shows the club. */
  onDone: () => void;
}

type Step = 'welcome' | 'club' | 'controls' | 'training' | 'finish';
const STEPS: { id: Step; label: string }[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'club', label: 'Your club' },
  { id: 'controls', label: 'Controls' },
  { id: 'training', label: 'Training' },
  { id: 'finish', label: 'Kick-off' },
];

export function mountOnboarding(root: HTMLElement, o: OnboardingOptions): () => void {
  let step: Step = 'welcome';
  let nameDraft = '';
  let nameError = '';
  let trained = false;
  let stopTutorial: (() => void) | null = null;
  let done = false;

  root.innerHTML = `<div class="onboarding" data-onboarding></div>`;
  const host = root.firstElementChild as HTMLElement;

  const progress = () => {
    const i = STEPS.findIndex((x) => x.id === step);
    return `<ol class="ob-progress" aria-label="Setup steps">${STEPS.map(
      (x, j) =>
        `<li class="${j < i ? 'done' : j === i ? 'on' : ''}"${j === i ? ' aria-current="step"' : ''}><span class="ob-dot" aria-hidden="true"></span><span class="ob-step-label">${x.label}</span><span class="sr-only">${j < i ? ', done' : ''}</span></li>`,
    ).join('')}</ol>
    <p class="ob-count">Step ${i + 1} of ${STEPS.length}</p>`;
  };

  const kit = (c: Save['club']) =>
    `<span class="ob-kit" role="img" aria-label="Kit colours"><span style="background:${c.primary}"></span><span style="background:${c.secondary}"></span></span>`;

  function body(): string {
    const c = o.save.club;
    switch (step) {
      case 'welcome':
        return `<section class="panel ob-card ob-welcome" aria-labelledby="ob-title">
          <h2 id="ob-title" class="ob-title" tabindex="-1">Welcome, coach</h2>
          <p class="ob-lede">Overlap is a football club manager where you also play every match yourself, with the mouse or the keyboard.</p>
          <p class="muted">Setup takes about two minutes: name your club, pick your controls, then a short session on the training ground.</p>
          <div class="ob-nav"><span></span><button class="btn primary big" data-ob="next" type="button">Set up my club</button></div>
        </section>`;
      case 'club':
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
          <div class="ob-nav"><button class="btn ghost" data-ob="back" type="button">Back</button><button class="btn primary" data-ob="next" type="button">Next: controls</button></div>
        </section>`;
      case 'controls': {
        const ctl = o.prefs.controls;
        const opt = (v: ControlStyle, title: string, text: string) => `<label class="ob-choice${ctl === v ? ' on' : ''}">
            <input type="radio" name="controls" id="ob-ctl-${v}" value="${v}" data-ob-change="controls"${ctl === v ? ' checked' : ''}>
            <span class="ob-choice-title">${title}</span><span class="ob-choice-text muted">${text}</span></label>`;
        return `<section class="panel ob-card" aria-labelledby="ob-title">
          <h2 id="ob-title" class="ob-title" tabindex="-1">How do you want to play?</h2>
          <fieldset class="ob-choices">
            <legend class="sr-only">Control style</legend>
            ${opt('mouse', 'Mouse (recommended)', 'Your player runs to the pointer. Click to pass.')}
            ${opt('keys', 'Keyboard', 'Arrow keys or WASD to run, Space to pass.')}
          </fieldset>
          ${controlsCard(ctl)}
          <p class="muted small">You can switch any time. The game follows whichever one you use.</p>
          <div class="ob-nav"><button class="btn ghost" data-ob="back" type="button">Back</button><button class="btn primary" data-ob="next" type="button">Next: training ground</button></div>
        </section>`;
      }
      case 'training':
        return `<div id="ob-training"></div>`;
      case 'finish': {
        const opp = o.nextOpp;
        return `<section class="panel ob-card" aria-labelledby="ob-title">
          <h2 id="ob-title" class="ob-title" tabindex="-1">${trained ? 'Training done' : 'Ready for kick-off'}</h2>
          <p class="ob-lede">Your first ranked match is against ${esc(opp.name)}.</p>
          <div class="versus ob-versus">
            <div class="side">${crestSvg(c, 56)}<div class="side-name">${esc(c.name)}</div><div class="side-elo">Elo ${c.elo}</div></div>
            <div class="vs" aria-hidden="true">vs</div>
            <div class="side">${crestSvg(opp, 56)}<div class="side-name">${esc(opp.name)}</div><div class="side-elo">Elo ${opp.elo}</div></div>
          </div>
          <ul class="ob-tips">
            <li>Win ranked matches to climb the ladder and earn prize money.</li>
            <li>Every match earns training sessions. Spend them on the Training tab.</li>
            <li>Replay the training ground any time from Club news.</li>
          </ul>
          <div class="ob-nav"><button class="btn ghost" data-ob="back" type="button">Back</button><button class="btn primary big" data-ob="done" type="button">Go to the club</button></div>
        </section>`;
      }
    }
  }

  function render(focusTitle = false) {
    if (done) return;
    stopTutorial?.();
    stopTutorial = null;
    const key = focusTitle ? null : captureFocus(host);
    host.innerHTML = `
      <header class="ob-top">
        <h1 class="wordmark">Overlap</h1>
        <button class="btn small ghost" data-action="skip-onboarding" type="button">Skip setup</button>
      </header>
      <nav class="ob-steps" aria-label="Setup progress">${progress()}</nav>
      <main id="main" class="ob-main" tabindex="-1">${body()}</main>`;
    if (step === 'training') {
      stopTutorial = mountTutorial(host.querySelector<HTMLElement>('#ob-training')!, {
        home: toTeamSetup(o.save.club, o.save.squad, o.save.lineup, 0.6),
        controls: o.prefs.controls,
        onDone: (completed) => {
          stopTutorial = null;
          trained = completed;
          go('finish');
        },
      });
      return;
    }
    if (focusTitle) host.querySelector<HTMLElement>('#ob-title')?.focus();
    else restoreFocus(host, key);
  }

  function go(to: Step) {
    step = to;
    nameError = '';
    render(true);
    window.scrollTo({ top: 0 });
  }

  function finish() {
    if (done) return;
    stopTutorial?.();
    stopTutorial = null;
    done = true;
    o.onDone();
  }

  const order = STEPS.map((x) => x.id);
  host.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-ob], [data-action="skip-onboarding"]');
    if (!el) return;
    if (el.dataset.action === 'skip-onboarding') return finish();
    const s = o.save;
    switch (el.dataset.ob) {
      case 'next':
        return go(order[order.indexOf(step) + 1]);
      case 'back':
        // Back from the end skips over the training ground rather than restarting it.
        return go(step === 'finish' ? 'controls' : order[Math.max(0, order.indexOf(step) - 1)]);
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
      case 'done':
        return finish();
    }
  });

  host.addEventListener('submit', (e) => {
    const form = e.target as HTMLFormElement;
    if (form.dataset.obForm !== 'name') return;
    e.preventDefault();
    const input = form.querySelector<HTMLInputElement>('#ob-name')!;
    nameDraft = input.value;
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
    host.querySelector<HTMLElement>('[data-ob="next"]')?.focus();
    announce(`Club renamed to ${o.save.club.name}, short code ${o.save.club.short.split('').join(' ')}.`);
  });

  host.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'ob-name') nameDraft = el.value;
  });

  host.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.obChange !== 'controls') return;
    o.prefs.controls = el.value === 'keys' ? 'keys' : 'mouse';
    o.savePrefs();
    render();
  });

  render(true);
  return () => {
    done = true;
    stopTutorial?.();
    stopTutorial = null;
  };
}
