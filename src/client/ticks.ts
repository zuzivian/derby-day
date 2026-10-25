// How a live match turns wall time into fixed 60 Hz sim ticks, frame by frame.
//
// Each frame adds its elapsed time to an accumulator and runs a tick for every whole DT in it. On a
// 120/144 Hz screen most frames then run no tick at all, so a click or key that lands between ticks
// waits for the next frame that does: up to a tick (16.7 ms) more before the kick happens and shows.
// When an action is waiting, the first tick of the frame is taken now instead, borrowed from the next:
// the accumulator goes negative by what was borrowed, so the sim still runs at real time on average
// and never more than one tick ahead. Ticks and their inputs are the same either way; only when a tick
// runs moves, so match outcomes (and replays) do not change.

import { DT } from '../sim/constants.ts';

/**
 * Should the loop run another tick this frame? acc: the accumulator after this frame's time was
 * added (minus DT per tick already run); ran: ticks run this frame so far; waiting: an input action
 * (pass, shot, tackle, switch…) is waiting for a tick.
 */
export function tickDue(acc: number, ran: number, waiting: boolean): boolean {
  if (acc >= DT) return true;
  // Borrow one tick, the frame's first, and only when nothing is borrowed already.
  return waiting && ran === 0 && acc >= 0;
}
