import { describe, expect, test } from 'bun:test';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { Lockstep, syncHash, type LockstepMsg } from '../src/net/lockstep.ts';
import { botInput, drivePair, MemoryNetwork, type LinkOptions } from '../src/net/memory.ts';
import { createMatch, fingerprint, step } from '../src/sim/match.ts';
import type { HumanInput, MatchState, TeamInputs } from '../src/sim/types.ts';

function setup(seed = 11) {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return { home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)) };
}

/** Both peers build their state from the same (cloned) start message, as in the browser. */
function newMatch(seed: number, halfSeconds = 30): MatchState {
  return createMatch({ seed, ...structuredClone(setup()), halfSeconds, humans: [true, true] });
}

function pair(link: LinkOptions, delay: number, seed = 5, halfSeconds = 30) {
  const net = new MemoryNetwork<LockstepMsg>(link);
  const now = () => net.now;
  const peers: [Lockstep, Lockstep] = [
    new Lockstep({ state: newMatch(seed, halfSeconds), side: 0, transport: net.ends[0], delay, now }),
    new Lockstep({ state: newMatch(seed, halfSeconds), side: 1, transport: net.ends[1], delay, now }),
  ];
  return { net, peers };
}

/** Wrap a sampler so every input it hands out is recorded under the tick it is scheduled for. */
function recording(sample: () => HumanInput, peer: () => Lockstep, log: Map<number, HumanInput>) {
  return () => {
    const inp = sample();
    log.set(peer().s.tick + 1 + peer().delay, inp);
    return inp;
  };
}

describe('lockstep', () => {
  test('two peers over a jittery, reordering, lossy link reach identical states', () => {
    const links: LinkOptions[] = [
      { seed: 1, minMs: 5, maxMs: 60 },
      { seed: 2, minMs: 30, maxMs: 140 },
      { seed: 3, minMs: 0, maxMs: 25, drop: 0.1 },
    ];
    links.forEach((link, i) => {
      const { net, peers } = pair(link, 5, 100 + i);
      const logs = [new Map<number, HumanInput>(), new Map<number, HumanInput>()];
      const samplers: [() => HumanInput, () => HumanInput] = [
        recording(botInput(10 + i), () => peers[0], logs[0]),
        recording(botInput(20 + i), () => peers[1], logs[1]),
      ];
      const N = 1500;
      drivePair(net, peers, samplers, N);
      net.advance(500); // let the last hashes land
      expect(peers[0].s.tick).toBe(N);
      expect(peers[1].s.tick).toBe(N);
      expect(peers[0].desync).toBeNull();
      expect(peers[1].desync).toBeNull();
      expect(fingerprint(peers[0].s)).toBe(fingerprint(peers[1].s));
      expect(peers[0].s.rng.s).toBe(peers[1].s.rng.s);
      // Every hash matched; on the lossy link some hash messages are simply lost (they aren't re-sent).
      if (link.drop) expect(peers[0].checksPassed).toBeGreaterThan(N / 60 / 2);
      else expect(peers[0].checksPassed).toBe(N / 60);
      // 140 ms one way is far more than 5 ticks of delay can hide.
      if (link.maxMs > 100) expect(peers[0].stalls + peers[1].stalls).toBeGreaterThan(0);

      // Both equal an offline replay of the same input log: nothing but inputs crossed the wire.
      const offline = newMatch(100 + i);
      for (let t = 1; t <= N; t++) {
        const inputs: TeamInputs = [logs[0].get(t) ?? {}, logs[1].get(t) ?? {}];
        step(offline, inputs);
      }
      expect(fingerprint(offline)).toBe(fingerprint(peers[0].s));
    });
  });

  test('the inputs actually steer: a different input log gives a different match', () => {
    const run = (botSeed: number) => {
      const { net, peers } = pair({ seed: 9, minMs: 5, maxMs: 30 }, 4);
      drivePair(net, peers, [botInput(botSeed), botInput(77)], 900);
      return fingerprint(peers[0].s);
    };
    expect(run(1)).not.toBe(run(2));
  });

  test('a peer runs exactly `delay` ticks ahead, then stalls until the other side sends', () => {
    const { net, peers } = pair({ seed: 4, minMs: 10, maxMs: 10 }, 6);
    const st = drivePair(net, peers, [botInput(1), botInput(2)], 300, { run: [true, false], maxMs: 2000 });
    expect(peers[0].s.tick).toBe(6);
    expect(peers[1].s.tick).toBe(0);
    expect(st.stalledMs[0]).toBeGreaterThan(1500);
    expect(peers[0].tick(() => ({}))).toBe(false);
    // The other side wakes up: both catch up and finish level.
    drivePair(net, peers, [botInput(1), botInput(2)], 300);
    expect(peers[0].s.tick).toBe(300);
    expect(peers[1].s.tick).toBe(300);
    expect(fingerprint(peers[0].s)).toBe(fingerprint(peers[1].s));
  });

  test('a dead link stalls both sides, and retransmits recover it', () => {
    const { net, peers } = pair({ seed: 6, minMs: 5, maxMs: 20 }, 4);
    const samplers: [() => HumanInput, () => HumanInput] = [botInput(3), botInput(4)];
    drivePair(net, peers, samplers, 200);
    net.up[1] = false; // everything peer 1 sends is lost for a while
    drivePair(net, peers, samplers, 400, { maxMs: 1500 });
    expect(peers[0].s.tick).toBeLessThanOrEqual(200 + 4 + 1);
    net.up[1] = true;
    drivePair(net, peers, samplers, 400);
    expect(peers[0].s.tick).toBe(400);
    expect(peers[1].s.tick).toBe(400);
    expect(syncHash(peers[0].s)).toBe(syncHash(peers[1].s));
  });

  test('corrupting one side is caught as a desync at the next check, and both sides stop', () => {
    const { net, peers } = pair({ seed: 8, minMs: 5, maxMs: 40 }, 5);
    const samplers: [() => HumanInput, () => HumanInput] = [botInput(5), botInput(6)];
    drivePair(net, peers, samplers, 100);
    expect(peers[0].desync).toBeNull();
    let reported = -1;
    peers[1].onDesync = (d) => (reported = d.tick);
    peers[0].s.players[3].pos.x += 0.5; // stand-in for "a float differs between engines"
    drivePair(net, peers, samplers, 600);
    expect(peers[0].desync?.tick).toBe(120);
    expect(peers[1].desync?.tick).toBe(120);
    expect(reported).toBe(120);
    // Stopped: neither side gets far past the check that failed.
    expect(peers[0].s.tick).toBeLessThan(130);
    expect(peers[1].s.tick).toBeLessThan(130);
    expect(peers[0].running).toBe(false);
    expect(peers[0].tick(() => ({}))).toBe(false);
  });

  test('a short match ends at the same tick and score on both sides, with a final hash check', () => {
    const { net, peers } = pair({ seed: 12, minMs: 10, maxMs: 50 }, 5, 21, 8);
    drivePair(net, peers, [botInput(31), botInput(32)], 1e9);
    net.advance(500); // let the last hash arrive
    expect(peers[0].s.phase).toBe('fulltime');
    expect(peers[1].s.phase).toBe('fulltime');
    expect(peers[0].s.tick).toBe(peers[1].s.tick);
    expect(peers[0].s.score).toEqual(peers[1].s.score);
    expect(peers[0].desync).toBeNull();
    expect(peers[1].desync).toBeNull();
    expect(peers[1].checksPassed).toBeGreaterThan(0);
  });

  test('bye tells the other side the peer left', () => {
    const { net, peers } = pair({ seed: 2, minMs: 1, maxMs: 2 }, 4);
    let left = false;
    peers[1].onPeerLeft = () => (left = true);
    peers[0].leave();
    net.advance(5);
    expect(left).toBe(true);
    expect(peers[1].running).toBe(false);
  });
});
