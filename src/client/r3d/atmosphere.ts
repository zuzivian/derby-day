// Time of day for a match: an afternoon in the sun, a low sun at dusk with the floodlights coming on,
// or a floodlit night. Each fixture keeps its own (picked from the two clubs, so the live match and
// its replays agree), and ?tod=day|dusk|night overrides it for testing.
//
// The pitch is lit to about the same brightness and hue at every time of day (the floodlights are
// tuned to it): the kit-versus-grass readability model in kits.ts is fitted to the grass as drawn,
// and a shirt that needs its dark rim in the afternoon needs it under the lights too.
// tests/atmosphere.test.ts holds each preset's light on the grass and on a shirt to the afternoon's.

import type { PostSettings } from './post.ts';
import { hash01 } from './space.ts';

export type TimeOfDay = 'day' | 'dusk' | 'night';

export interface Atmosphere {
  tod: TimeOfDay;
  /** Sky dome: zenith, horizon band, below the horizon. */
  sky: [string, string, string];
  background: string;
  fog: { color: string; near: number; far: number };
  hemi: { sky: string; ground: string; intensity: number };
  /** The shadow-casting light (the sun, or the main bank of floodlights), placed at this offset from the view's focus. */
  key: { color: string; intensity: number; offset: [number, number, number] };
  fill: { color: string; intensity: number; position: [number, number, number] };
  /** Floodlight lamps: brightness (1 = a plain white lamp face, more for bloom), and the glow sprites' opacity. */
  lamps: number;
  glow: number;
  /** Light cones from the floodlight heads, and their shadows thrown away from each other pylon. */
  beams: number;
  spokes: number;
  clouds: { color: string; emissive: string; intensity: number; show: boolean };
  /** Camera flashes popping in the crowd (0 = none). */
  flashes: number;
  /** How bright the stands and the crowd are against the pitch (1 = as lit; under the lights they sit in the spill). */
  stands: number;
  post: PostSettings;
}

export const ATMOSPHERES: Record<TimeOfDay, Atmosphere> = {
  day: {
    tod: 'day',
    sky: ['#2f78d6', '#7fb6ee', '#dbe9f5'],
    background: '#9cc8f0',
    fog: { color: '#c6dcf0', near: 220, far: 1100 },
    hemi: { sky: '#d6ebff', ground: '#4d7d3a', intensity: 1.5 },
    key: { color: '#fff1dc', intensity: 2.3, offset: [-55, 70, 78] },
    fill: { color: '#dce8ff', intensity: 0.35, position: [30, 40, 60] },
    lamps: 1,
    glow: 0.45,
    beams: 0,
    spokes: 0,
    clouds: { color: '#ffffff', emissive: '#c9d8ea', intensity: 0.55, show: true },
    flashes: 0,
    stands: 1,
    post: { bloom: 0.22, threshold: 1.9, knee: 0.6, vignette: 0.18 },
  },
  dusk: {
    tod: 'dusk',
    sky: ['#34477f', '#d98f7c', '#ffcf94'],
    background: '#e3a27e',
    fog: { color: '#cf9a86', near: 200, far: 1000 },
    hemi: { sky: '#e2e6f0', ground: '#4d7a3a', intensity: 2.2 },
    // A low sun from behind the near left corner: long shadows across the pitch.
    key: { color: '#ffe2c4', intensity: 2.25, offset: [-92, 44, 60] },
    fill: { color: '#c4d0ff', intensity: 0.55, position: [40, 45, -30] },
    lamps: 3.5,
    glow: 0.75,
    beams: 0,
    spokes: 0,
    clouds: { color: '#ffd9c0', emissive: '#e7906c', intensity: 0.7, show: true },
    flashes: 0.3,
    stands: 0.8,
    post: { bloom: 0.5, threshold: 1.5, knee: 0.6, vignette: 0.24 },
  },
  night: {
    tod: 'night',
    sky: ['#03070f', '#0d1830', '#2a3958'],
    background: '#0b1426',
    fog: { color: '#101b2e', near: 180, far: 900 },
    // Under the floodlights: a white key from one bank, a touch of fill from the opposite one, the stands'
    // spill as the ambient. Together they put about the afternoon's light on the grass and on the shirts.
    // The banks stand far back, so on the pitch the main one comes in about as high as the afternoon sun.
    hemi: { sky: '#c4cfe0', ground: '#40603a', intensity: 1.15 },
    key: { color: '#fbfbff', intensity: 3.0, offset: [-48, 66, 58] },
    fill: { color: '#f4f6ff', intensity: 0.1, position: [50, 55, -45] },
    lamps: 9,
    glow: 1,
    beams: 1,
    spokes: 0.2,
    clouds: { color: '#ffffff', emissive: '#000000', intensity: 0, show: false },
    flashes: 1,
    stands: 0.6,
    post: { bloom: 0.75, threshold: 1.35, knee: 0.7, vignette: 0.3 },
  },
};

/** This fixture's time of day: from the clubs (so it stays the same for the match and its replays), or ?tod=. */
export function pickTimeOfDay(home: string, away: string, query: string | null = null): TimeOfDay {
  if (query === 'day' || query === 'dusk' || query === 'night') return query;
  const h = hash01(`${home}|${away}`, 77);
  return h < 0.45 ? 'day' : h < 0.65 ? 'dusk' : 'night';
}

/** ?tod= from the page address, if there is one. */
export function todQuery(): string | null {
  try {
    return new URLSearchParams(location.search).get('tod');
  } catch {
    return null;
  }
}
