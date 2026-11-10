// Club level UI: the header badge and XP bar, the "Club level" panel on the
// Club screen, the XP lines on the result dialog, the level-up dialog and the
// crest and kit pickers that come with two of the perks. The rules and the
// unlock table live in src/meta/levels.ts; this file only renders.
// Styles are in levels.css (appended to the page by scripts/build.ts).

import type { Save } from '../meta/game.ts';
import { crestSvg } from './crest.ts';
import { KIT_PALETTE } from '../meta/identity.ts';
import {
  badgeTier,
  clubLevel,
  isUnlocked,
  levelForXp,
  levelText,
  nextUnlocks,
  nextUnlockText,
  pendingUnlocks,
  totalXpForLevel,
  UNLOCKS,
  unlockLevel,
  XP,
  xpSummary,
  type Unlock,
  type XpGain,
} from '../meta/levels.ts';
import { CREST_PATTERNS } from '../meta/names.ts';
import { esc } from './html.ts';


const fmt = (n: number) => n.toLocaleString('en-GB');

/** True while the level-up dialog should be on screen (it waits behind the result dialog). */
export const levelUpOpen = (s: Save): boolean => pendingUnlocks(s).length > 0;

/** Header: level badge (a button to the Club level panel) and the XP bar. */
export function levelChip(s: Save): string {
  const p = levelForXp(s.xp ?? 0);
  const pct = p.maxed ? 100 : Math.min(100, Math.round((p.intoLevel / p.needed) * 100));
  const now = p.maxed ? p.needed : Math.min(p.intoLevel, p.needed);
  const valueText = p.maxed ? 'Max level' : `${fmt(p.intoLevel)} of ${fmt(p.needed)} XP`;
  return `<div class="level-chip">
    ${isUnlocked(s, 'club')
      ? `<button class="level-badge tier-${badgeTier(p.level)}" type="button" data-action="level-open" aria-label="Club level ${p.level}: show unlocks">${p.level}</button>`
      : `<span class="level-badge tier-${badgeTier(p.level)}" role="img" aria-label="Club level ${p.level}">${p.level}</span>`}
    <div class="xp">
      <span class="xp-text" id="xp-text">${esc(levelText(p))}</span>
      <span class="xp-bar" role="progressbar" aria-labelledby="xp-text" aria-valuemin="0" aria-valuemax="${p.needed}" aria-valuenow="${now}" aria-valuetext="${esc(`Level ${p.level}, ${valueText}`)}"><span style="width:${pct}%"></span></span>
    </div>
  </div>`;
}

function statusOf(s: Save, u: Unlock, nextLevel: number | null): 'done' | 'next' | 'later' {
  if (isUnlocked(s, u.id)) return 'done';
  return unlockLevel(s, u.id) === nextLevel ? 'next' : 'later';
}

function unlockRow(s: Save, u: Unlock, nextLevel: number | null): string {
  const st = statusOf(s, u, nextLevel);
  const toGo = fmt(Math.max(0, totalXpForLevel(unlockLevel(s, u.id)) - (s.xp ?? 0)));
  const status = st === 'done' ? 'Unlocked' : `${st === 'next' ? 'Next' : `Level ${unlockLevel(s, u.id)}`} · ${toGo} XP to go`;
  return `<li class="unlock unlock-${st}">
    <span class="unlock-level" aria-hidden="true">${unlockLevel(s, u.id)}</span>
    <span class="unlock-body"><span class="unlock-name"><b>${esc(u.name)}</b>${u.kind === 'perk' ? ' <span class="pill perk-pill">perk</span>' : ''}</span><span class="muted small">${esc(u.text)}</span></span>
    <span class="unlock-status">${st === 'done' ? '<span aria-hidden="true">✓ </span>' : ''}${status}<span class="visually-hidden">, level ${unlockLevel(s, u.id)}</span></span>
  </li>`;
}

/** The Club level panel on the Club screen: the teaser, how to earn XP, and every unlock and perk. */
export function levelPanel(s: Save): string {
  const p = levelForXp(s.xp ?? 0);
  const next = nextUnlocks(s);
  const nextLevel = next[0] ? unlockLevel(s, next[0].id) : null;
  const teaser = nextUnlockText(s);
  const done = UNLOCKS.filter((u) => isUnlocked(s, u.id)).length;
  const toNext = p.level < 99 ? totalXpForLevel(p.level + 1) - (s.xp ?? 0) : 0;
  return `
  <article class="panel level-panel" aria-labelledby="level-title">
    <div class="board-head">
      <h2 id="level-title" class="eyebrow" tabindex="-1">Club level</h2>
      <span class="level-total muted small">${fmt(s.xp ?? 0)} XP in total${p.level < 99 ? ` · ${fmt(toNext)} to level ${p.level + 1}` : ''}</span>
    </div>
    <div class="level-meter"><span class="level-badge tier-${badgeTier(p.level)}" aria-hidden="true">${p.level}</span><span class="xp-bar" role="img" aria-label="${esc(levelText(p))}"><span style="width:${p.maxed ? 100 : Math.round((p.intoLevel / p.needed) * 100)}%"></span></span>${p.level < 99 ? `<span class="level-badge tier-${badgeTier(p.level + 1)} dim" aria-hidden="true">${p.level + 1}</span>` : ''}</div>
    ${teaser
      ? `<p class="level-next" id="next-unlock"><span class="level-next-label">Next unlock</span> ${esc(teaser)}</p>`
      : `<p class="level-next" id="next-unlock"><span class="level-next-label">Everything unlocked</span> ${p.maxed ? 'Max level. Your XP keeps counting.' : 'Keep going: level 99 is the cap.'}</p>`}
    <p class="muted small">XP: ranked, cup or league win ${XP.win}, draw ${XP.draw}, loss ${XP.loss}, +${XP.goal} a goal, +${XP.cleanSheet} for a clean sheet, more against stronger clubs and in higher divisions (up to about ×2.3), less against weak ones. Practice ${XP.practice.easy} to ${XP.practice.hard}. Each training session +${XP.trainingSession}. Cup and league finishes and first-time milestones pay extra. Forfeits earn nothing.</p>
    ${next.length ? `<ul class="unlock-list unlock-list-next" aria-label="Next unlock">${next.map((u) => unlockRow(s, u, nextLevel)).join('')}</ul>` : ''}
    <details class="unlock-all">
      <summary>All unlocks and perks · ${done} of ${UNLOCKS.length} unlocked</summary>
      <ul class="unlock-list">${UNLOCKS.map((u) => unlockRow(s, u, nextLevel)).join('')}</ul>
    </details>
  </article>`;
}

/**
 * The XP card on the result dialog: the gain (".xp-gain": "+150 XP: win 120,
 * 3 goals 30"), the club level badge and a bar that fills from where the club
 * was to where it is now. Crossing a level, the bar runs to the end, the badge
 * turns over to the new level and a "Level up" flourish pops. CSS animates it
 * (levels.css); with reduced motion the final state shows at once.
 */
export function xpCardHtml(s: Save, gain: XpGain | undefined, forfeited: boolean): string {
  if (!gain) return '';
  const xpNow = s.xp ?? 0;
  const after = levelForXp(xpNow);
  if (!gain.total) {
    return `<div class="xp-card is-empty">
      <span class="level-badge tier-${badgeTier(after.level)}" aria-hidden="true"><span>${after.level}</span></span>
      <div class="xp-card-body"><p class="xp-gain">No XP${forfeited ? ' for a forfeit' : ''}</p><p class="xp-card-level">${esc(levelText(after))}</p></div>
    </div>`;
  }
  const before = levelForXp(Math.max(0, xpNow - gain.total));
  const up = after.level > before.level;
  const pct = (p: ReturnType<typeof levelForXp>) => (p.maxed ? 100 : Math.max(0, Math.min(100, (p.intoLevel / p.needed) * 100)));
  const from = up ? 0 : pct(before);
  const to = pct(after);
  const [head] = xpSummary(gain).split(': ');
  // One part repeats the total ("+50 XP: loss 50"), so it shows the reason alone; several show each share.
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  const parts = gain.parts.length === 1 ? cap(gain.parts[0]!.label) : gain.parts.map((p) => `${cap(p.label)} ${p.xp.toLocaleString('en-GB')}`).join(' · ');
  const lvFrom = Math.min(gain.levelBefore, before.level);
  const lvTo = Math.max(gain.levelAfter, after.level);
  const next = nextUnlockText(s);
  return `<div class="xp-card${up ? ' is-levelup' : ''}" style="--xp-from:${pct(before).toFixed(1)}%;--xp-to:${to.toFixed(1)}%;--xp-start:${from.toFixed(1)}%">
    <span class="level-badge tier-${badgeTier(after.level)}" aria-hidden="true">${up ? `<span class="xp-lv-old">${before.level}</span><span class="xp-lv-new">${after.level}</span>` : `<span>${after.level}</span>`}</span>
    <div class="xp-card-body">
      <p class="xp-gain"><b>${esc(head)}</b><span class="xp-colon">: </span><span class="xp-parts">${esc(parts)}</span></p>
      <span class="xp-card-track" aria-hidden="true"><span class="xp-card-fill"></span></span>
      <p class="xp-card-level">${esc(levelText(after))}</p>
      ${up || after.maxed || !next ? '' : `<p class="xp-card-next">Next: ${esc(next)}</p>`}
    </div>
    ${up ? `<p class="xp-level"><span class="xp-level-tag">Level up</span> <span class="xp-level-nums">${lvFrom} → ${lvTo}</span></p>` : ''}
  </div>`;
}

/** The level-up dialog: what just unlocked, and a button straight to the first new feature. */
export function levelUpModal(s: Save): string {
  const fresh = pendingUnlocks(s);
  if (!fresh.length) return '';
  const level = clubLevel(s);
  const target = fresh.find((u) => u.go);
  const next = nextUnlockText(s);
  return `
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="levelup-title" aria-describedby="levelup-lede">
    <div class="modal-card levelup-card">
      <div class="levelup-hero">
        <span class="levelup-rays" aria-hidden="true"></span>
        <div class="levelup-eyebrow">Level up</div>
        <span class="level-badge big tier-${badgeTier(level)}" aria-hidden="true">${level}</span>
        <h2 id="levelup-title" class="levelup-title" tabindex="-1">Level ${level}</h2>
      </div>
      <div class="levelup-body">
        <p id="levelup-lede" class="levelup-lede">${fresh.length === 1 ? 'You unlocked something new' : `You unlocked ${fresh.length} new things`}<span class="visually-hidden">: ${esc(fresh.map((u) => u.name).join(', '))}.</span></p>
        <ul class="unlock-list levelup-list">${fresh.map((u) => `<li class="unlock unlock-done"><span class="unlock-level" aria-hidden="true">${unlockLevel(s, u.id)}</span><span class="unlock-body"><b>${esc(u.name)}</b><span class="muted small">${esc(u.text)}</span></span>${u.kind === 'perk' ? '<span class="pill perk-pill">perk</span>' : '<span class="pill new-pill">new</span>'}</li>`).join('')}</ul>
        ${next ? `<p class="levelup-next"><span class="level-next-label">Next</span> ${esc(next)}</p>` : ''}
        <div class="levelup-actions">
          ${target ? `<button class="btn primary big" data-action="levelup-go" data-id="${esc(target.id)}">${esc(target.go!.label === 'Show me' ? `Try ${target.name}` : target.go!.label)}</button>` : ''}
          <button class="btn${target ? ' ghost' : ' primary big'}" data-action="levelup-close">${target ? 'Later' : 'Back to the club'}</button>
        </div>
      </div>
    </div>
  </div>`;
}

/** What screen readers hear when the level-up dialog opens. */
export function levelUpAnnouncement(s: Save): string {
  const fresh = pendingUnlocks(s);
  return `Level ${clubLevel(s)}. Unlocked: ${fresh.map((u) => u.name).join(', ')}.`;
}

let identityFresh = false;
/** The next render plays the "saved" moment. */
export const flagIdentitySaved = (): void => void (identityFresh = true);

/** Crest, kit and trim pickers for Club news, once those perks are unlocked: a live preview and radio swatches. */
export function identityControls(s: Save): string {
  const crest = isUnlocked(s, 'crest');
  const kit = isUnlocked(s, 'kit');
  if (!crest && !kit) return '';
  const c = s.club;
  const fresh = identityFresh;
  identityFresh = false;
  const cap = (p: string) => p[0].toUpperCase() + p.slice(1);
  const swatches = (key: string, label: string, hint: string, value: string, other: string) => `<fieldset class="identity-set"><legend>${label}</legend>
    <div class="swatches">${KIT_PALETTE.map((k) => {
      const same = k.hex === other;
      return `<label class="sw" style="--c:${k.hex}" title="${esc(k.name)}${same ? '' : ''}"><input type="radio" class="sr-only" name="${key}" id="${key}-${k.hex.slice(1)}" value="${k.hex}" data-change="${key}"${k.hex === value ? ' checked' : ''}${same ? ' disabled' : ''}><span class="sw-chip" aria-hidden="true"></span><span class="sr-only">${esc(k.name)}</span></label>`;
    }).join('')}</div><p class="muted small">${hint}</p></fieldset>`;
  return `<fieldset class="identity-editor"><legend class="eyebrow">Club identity</legend>
    <div class="identity-preview${fresh ? ' fresh' : ''}">${crestSvg(c, 76)}
      <div class="identity-meta"><strong>${esc(c.name)}</strong>
        <span class="identity-saved" aria-hidden="true">${fresh ? '✓ Saved' : 'Saves as you pick'}</span></div></div>
    ${crest ? `<fieldset class="identity-set"><legend>Crest</legend><div class="crest-opts">${CREST_PATTERNS.map((p) => `<label class="crest-opt"><input type="radio" class="sr-only" name="crest" id="crest-${p}" value="${p}" data-change="crest"${p === c.crest ? ' checked' : ''}>${crestSvg({ ...c, crest: p }, 38)}<span>${cap(p)}</span></label>`).join('')}</div></fieldset>` : ''}
    ${kit ? `${swatches('kit-primary', 'Kit colour', 'Shirt and crest.', c.primary, c.secondary)}${swatches('kit-secondary', 'Trim colour', 'Must differ from the kit.', c.secondary, c.primary)}` : ''}
  </fieldset>`;
}
