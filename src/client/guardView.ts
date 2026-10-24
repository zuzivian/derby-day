// The screen a second tab shows instead of the game: Derby Day is open in another tab.

import { takeWhenFree } from './tabguard.ts';

export interface GuardViewOptions {
  /** Why the screen is up: never claimed the club at boot, or lost it to another tab. */
  reason: 'other-tab' | 'taken' | 'newer';
  /** This tab took the club: reload to read the save fresh. */
  onTaken: () => void;
  /** Open the game read-only in this tab (Link play's second tab). */
  onGuest: () => void;
}

/** Full-screen overlay on <body>, so the game's own re-renders of #app can never wipe it. Returns a remover. */
export function showGuardScreen(o: GuardViewOptions): () => void {
  document.getElementById('guard')?.remove();
  const root = document.createElement('div');
  root.id = 'guard';
  document.body.appendChild(root);
  const appEl = document.getElementById('app');
  if (appEl) appEl.inert = true;
  if (o.reason === 'newer') {
    root.innerHTML = `
  <div class="guard" role="alertdialog" aria-modal="true" aria-labelledby="guard-title">
    <div class="guard-card">
      <h1 id="guard-title" tabindex="-1">Your club needs a newer version</h1>
      <p>This club was saved by a newer version of Derby Day than the one this page is running. Nothing has been changed. Reload to get the latest version.</p>
      <div class="guard-actions"><button class="btn primary" id="guard-reload">Reload</button></div>
    </div>
  </div>`;
    root.querySelector<HTMLElement>('#guard-title')?.focus();
    root.querySelector('#guard-reload')?.addEventListener('click', () => location.reload());
    return () => {
      root.remove();
      if (appEl) appEl.inert = false;
    };
  }
  root.innerHTML = `
  <div class="guard" role="alertdialog" aria-modal="true" aria-labelledby="guard-title">
    <div class="guard-card">
      <h1 id="guard-title" tabindex="-1">Derby Day is open in another tab</h1>
      <p>${o.reason === 'taken' ? 'You started playing in another tab, so this one stepped aside.' : 'Your club can only be played in one tab at a time, or the two tabs would overwrite each other\'s progress.'}</p>
      <div class="guard-actions">
        <button class="btn primary" id="guard-here" data-action="guard-here">Play here instead</button>
        <button class="btn ghost" id="guard-guest" data-action="guard-guest">Use as a guest tab</button>
      </div>
      <p class="guard-note muted small" id="guard-note" role="status" aria-live="polite">A guest tab can join a Link match, but nothing it does is saved.</p>
    </div>
  </div>`;
  const here = root.querySelector<HTMLButtonElement>('#guard-here')!;
  const note = root.querySelector<HTMLElement>('#guard-note')!;
  root.querySelector<HTMLElement>('#guard-title')?.focus();
  here.addEventListener('click', () => {
    here.disabled = true;
    note.textContent = 'Taking over…';
    void takeWhenFree(() => {
      note.textContent = 'A match is in progress in the other tab. This tab will take over as soon as it ends.';
    }).then(o.onTaken);
  });
  root.querySelector('#guard-guest')?.addEventListener('click', o.onGuest);
  return () => {
    root.remove();
    if (appEl) appEl.inert = false;
  };
}
