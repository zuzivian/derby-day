// Mouse "newbie" play helpers for the 3D match: a feedback controller on the sim's own reading of the pointer
// (s.humanAim[0] is the world point under the mouse each tick), so the mouse can be put over a world point.
const st = (page) => page.evaluate(() => {
  const s = window.__derbyMatch; if (!s) return null;
  const me = s.controlled[0];
  const tipEl = document.querySelector('.coach-tip');
  return {
    tick: s.tick, phase: s.phase, half: s.half, clock: s.clock, halfTicks: s.halfTicks, score: s.score.slice(),
    me, mePos: me >= 0 ? { ...s.players[me].pos } : null, owner: s.ball.owner, ownerTeam: s.ball.owner >= 0 ? s.players[s.ball.owner].team : -1,
    ball: { ...s.ball.pos }, aim: s.humanAim && s.humanAim[0] ? { ...s.humanAim[0] } : null,
    restart: s.restart && { kind: s.restart.kind, team: s.restart.team, stage: s.restart.stage, taker: s.restart.taker },
    mates: s.players.filter((p) => p.team === 0 && p.i !== me && !p.sentOff).map((p) => ({ i: p.i, x: p.pos.x, y: p.pos.y, role: p.role })),
    opps: s.players.filter((p) => p.team === 1).map((p) => ({ x: p.pos.x, y: p.pos.y })),
    tip: tipEl && !tipEl.hidden ? tipEl.dataset.coachTip : null,
    paused: !document.getElementById('pause')?.hidden,
  };
});

class Steer {
  constructor(page, box) { this.page = page; this.box = box; this.mx = box.x + box.width / 2; this.my = box.y + box.height / 2; this.kx = 22; this.ky = -14; }
  async move(x, y) { this.mx = Math.max(this.box.x + 4, Math.min(this.box.x + this.box.width - 4, x)); this.my = Math.max(this.box.y + 4, Math.min(this.box.y + this.box.height - 4, y)); await this.page.mouse.move(this.mx, this.my, { steps: 2 }); }
  /** Calibrate px per metre and sign by two test moves. */
  async calibrate() {
    await this.move(this.mx, this.my); await this.page.waitForTimeout(250); const a = (await st(this.page)).aim;
    await this.move(this.mx + 120, this.my); await this.page.waitForTimeout(250); const b = (await st(this.page)).aim;
    await this.move(this.mx, this.my + 80); await this.page.waitForTimeout(250); const c = (await st(this.page)).aim;
    if (a && b && c) {
      this.kx = 120 / ((b.x - a.x) || 1e-3);
      this.ky = 80 / ((c.y - b.y) || 1e-3);
    }
    return { kx: this.kx, ky: this.ky, a, b, c };
  }
  /** Nudge the mouse so the pointer's world point approaches target. Returns the remaining error in metres. */
  async toward(target, s) {
    if (!s || !s.aim) { await this.move(this.mx, this.my); return 99; }
    const ex = target.x - s.aim.x, ey = target.y - s.aim.y;
    await this.move(this.mx + ex * this.kx * 0.8, this.my + ey * this.ky * 0.8);
    return Math.hypot(ex, ey);
  }
}
module.exports = { st, Steer };
