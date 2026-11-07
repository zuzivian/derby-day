// Settings dialog (the Club tab's "Back up or restore" button opens it): back up the club to a file or a
// copyable code, and restore from either, after previewing what will be replaced. Mounted on <body>, outside
// #app, so the game's re-renders never wipe it half way through.

import { parseBackup, backupCode, backupFilename, backupJson, type BackupPreview } from './backup.ts';
import { dryRunBoot } from './dryrun.ts';
import { isSaveGuest, previousClub, replaceSave, restorePrevious, type WriteResult } from './store.ts';
import type { Save } from '../meta/game.ts';
import { showToast } from './a11y.ts';
import { expectRestore } from './tabguard.ts';
import { telemetry } from './telemetry.ts';

const esc = (t: string | number): string => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface SettingsHooks {
  getSave: () => Save;
  /** The club was replaced in storage: reload the game from it. */
  onImported: () => void;
}

/** After a restore is written: long enough for the browser to flush storage before the page reloads. */
const RELOAD_DELAY_MS = 300;

const failText = (r: WriteResult): string =>
  r === 'quota' ? 'This browser has no room left to store the club. Free some space and try again.' : r === 'guest' ? 'This tab is not the one that owns your club. Restore from the tab that does.' : r === 'mismatch' ? 'This browser did not keep the restored club, so nothing was changed. Try again, or use another browser.' : 'This browser blocked storage, so the backup could not be restored.';

export function openSettings(hooks: SettingsHooks, opener: HTMLElement | null): void {
  if (document.getElementById('settings-dialog')) return;
  const wrap = document.createElement('div');
  wrap.id = 'settings-dialog';
  wrap.className = 'modal settings';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-labelledby', 'settings-title');
  const save = hooks.getSave();
  const guestTab = isSaveGuest();
  const prev = previousClub();
  wrap.innerHTML = `
  <div class="modal-card settings-card">
    <h2 id="settings-title" tabindex="-1">Back up or restore</h2>
    <p class="muted">${esc(save.club.name)} is saved in this browser only. A backup lets you move it to another device or keep a copy safe.</p>
    <section class="settings-sec" aria-labelledby="bk-h">
      <h3 class="eyebrow" id="bk-h">Back up</h3>
      <div class="settings-actions">
        <button class="btn primary" id="bk-download" type="button">Download backup file</button>
        <button class="btn" id="bk-code" type="button" aria-expanded="false" aria-controls="bk-code-out">Show copyable code</button>
      </div>
      <p class="muted small">The file is the safest copy. The code is the same backup as text.</p>
      <div id="bk-code-out" hidden>
        <textarea id="bk-code-text" readonly rows="4" aria-label="Backup code"></textarea>
        <button class="btn small" id="bk-copy" type="button">Copy code</button>
      </div>
    </section>
    <section class="settings-sec" aria-labelledby="rs-h">
      <h3 class="eyebrow" id="rs-h">Restore a backup</h3>
    ${guestTab
      ? '<p class="muted">This is a guest tab, so it cannot change your club. Open this dialog in the tab that owns the club to restore a backup.</p>'
      : `<p class="muted small">You will see what is inside before anything is replaced.</p>
    <button class="btn" id="bk-choose" type="button">Choose a backup file…</button>
    <input type="file" id="bk-file" accept=".json,application/json,text/plain" hidden tabindex="-1">
    <textarea id="bk-paste" rows="2" placeholder="…or paste a backup code here" aria-label="Paste a backup code"></textarea>
    <div id="bk-preview" role="status" aria-live="polite"></div>
    ${prev ? `<div class="bk-prev"><p class="muted small">A safety copy of an earlier club is kept: <strong>${esc(prev.name)}</strong> (${prev.played} played).</p><button class="btn small" id="bk-undo" type="button">Swap back to ${esc(prev.name)}</button></div>` : ''}`}
    </section>
    ${telemetry.enabled ? `<section class="settings-sec" aria-labelledby="pv-h"><h3 class="eyebrow" id="pv-h">Privacy</h3><label class="check"><input type="checkbox" id="tl-off"${telemetry.optedOut() ? ' checked' : ''}> Don't send anonymous usage counts</label></section>` : ''}
    <div class="settings-foot"><button class="btn ghost" id="settings-close" type="button">Done</button></div>
  </div>`;
  document.body.appendChild(wrap);
  // Everything behind the dialog is inert while it is open (as the result and level-up dialogs do).
  const appEl = document.getElementById('app');
  const wasInert = appEl?.hasAttribute('inert') ?? false;
  if (!wasInert) appEl?.setAttribute('inert', '');
  const $ = <T extends HTMLElement>(id: string) => wrap.querySelector<T>('#' + id)!;
  $('settings-title').focus();

  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey, true);
    if (!wasInert) appEl?.removeAttribute('inert');
    (opener?.isConnected ? opener : document.querySelector<HTMLElement>('[data-action="open-backup"]') ?? document.getElementById('main'))?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      const f = [...wrap.querySelectorAll<HTMLElement>('button:not([disabled]),textarea,input:not([hidden])')].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    }
  };
  document.addEventListener('keydown', onKey, true);
  $('settings-close').addEventListener('click', close);
  wrap.addEventListener('mousedown', (e) => e.target === wrap && close());

  $('bk-download').addEventListener('click', () => {
    const s = hooks.getSave();
    const url = URL.createObjectURL(new Blob([backupJson(s)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = backupFilename(s);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast('Backup file downloaded.');
  });

  $('bk-code').addEventListener('click', async () => {
    const code = await backupCode(hooks.getSave());
    const out = $('bk-code-out');
    if (!code) {
      showToast('This browser cannot make a code. Download the file instead.', false);
      return;
    }
    out.hidden = false;
    $('bk-code').setAttribute('aria-expanded', 'true');
    const ta = $<HTMLTextAreaElement>('bk-code-text');
    ta.value = code;
    ta.focus();
    ta.select();
  });
  $('bk-copy').addEventListener('click', async () => {
    const ta = $<HTMLTextAreaElement>('bk-code-text');
    try {
      await navigator.clipboard.writeText(ta.value);
      showToast('Backup code copied.');
    } catch {
      ta.select();
      showToast('Press Ctrl+C (or ⌘C) to copy the selected code.', false);
    }
  });

  const preview = guestTab ? document.createElement('div') : $('bk-preview');
  const show = async (text: string) => {
    const r = await parseBackup(text);
    if (!r.ok) {
      preview.innerHTML = `<p class="bk-bad" role="alert">${esc(r.reason)}</p>`;
      return;
    }
    const broken = dryRunBoot(r.save);
    if (broken) {
      preview.innerHTML = '<p class="bk-bad" role="alert">This backup is damaged in a way that would stop the game from opening, so it was not used. Your club is untouched.</p>';
      return;
    }
    const p: BackupPreview = r.preview;
    const when = p.exportedAt ? ` · saved ${esc(new Date(p.exportedAt).toLocaleDateString('en-GB'))}` : '';
    preview.innerHTML = `
      <div class="bk-found"><strong>${esc(p.name)}</strong> · Level ${p.level} · ${p.played} played · Elo ${p.elo}${when}</div>
      <p class="muted small">Restoring replaces <strong>${esc(hooks.getSave().club.name)}</strong> in this browser, and the page reloads. Your current club is kept as a safety copy you can swap back to.</p>
      <button class="btn danger" id="bk-confirm" type="button">Replace my club with this backup</button>`;
    preview.querySelector('#bk-confirm')?.addEventListener('click', () => {
      const res = replaceSave(r.save);
      if (res !== 'ok') {
        preview.innerHTML = `<p class="bk-bad" role="alert">${esc(failText(res))}</p>`;
        return;
      }
      // Reloading at once can outrun the browser writing its storage to disk, and the next page would open the old club.
      preview.innerHTML = '<p class="bk-found" role="status">Restoring…</p>';
      expectRestore();
      setTimeout(() => {
        wrap.remove();
        document.removeEventListener('keydown', onKey, true);
        if (!wasInert) appEl?.removeAttribute('inert');
        hooks.onImported();
      }, RELOAD_DELAY_MS);
    });
  };
  if (guestTab) {
    $('tl-off')?.addEventListener('change', (e) => telemetry.setOptOut((e.target as HTMLInputElement).checked));
    return;
  }
  $('bk-choose').addEventListener('click', () => $<HTMLInputElement>('bk-file').click());
  $('bk-undo')?.addEventListener('click', () => {
    if (!restorePrevious()) {
      preview.innerHTML = '<p class="bk-bad" role="alert">The earlier club could not be restored.</p>';
      return;
    }
    expectRestore();
    wrap.remove();
    document.removeEventListener('keydown', onKey, true);
    if (!wasInert) appEl?.removeAttribute('inert');
    hooks.onImported();
  });
  $<HTMLInputElement>('bk-file').addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    if (f.size > 5_000_000) preview.innerHTML = '<p class="bk-bad" role="alert">That file is too big to be a Derby Day backup.</p>';
    else {
      let text = '';
      try {
        text = await f.text();
      } catch {
        preview.innerHTML = '<p class="bk-bad" role="alert">That file could not be read. Try choosing it again, or paste the backup code instead.</p>';
        return;
      }
      await show(text);
    }
  });
  $<HTMLTextAreaElement>('bk-paste').addEventListener('input', (e) => {
    const v = (e.target as HTMLTextAreaElement).value;
    if (v.trim()) void show(v);
    else preview.innerHTML = '';
  });
  $('tl-off')?.addEventListener('change', (e) => telemetry.setOptOut((e.target as HTMLInputElement).checked));
}
