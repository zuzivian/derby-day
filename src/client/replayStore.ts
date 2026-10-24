// The last few replays, in localStorage under derbyday.replays.v1 (see
// addRecent for the count and size caps). Every access is wrapped: storage can
// be missing, full or blocked, in which case replays live for this tab only.

import { addRecent, decodeReplay, encodeReplay, replayId, type Replay, type StoredReplay } from '../meta/replay.ts';

const KEY = 'derbyday.replays.v1';

/** Used when storage throws, so the result screen can still offer the replay it just recorded. */
let memory: StoredReplay[] = [];
let lastId: string | null = null;
const decoded = new Map<string, Replay>();

const isStored = (e: unknown): e is StoredReplay => !!e && typeof e === 'object' && typeof (e as StoredReplay).id === 'string' && typeof (e as StoredReplay).code === 'string' && typeof (e as StoredReplay).at === 'number';

/** Oldest first, as stored. */
function load(): StoredReplay[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return memory;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isStored) : [];
  } catch {
    return memory;
  }
}

/** Keep a finished match's replay (newest last). Returns it, or null if it could not be encoded. */
export function storeReplay(r: Replay): StoredReplay | null {
  try {
    const entry: StoredReplay = { id: replayId(r), at: r.at, code: encodeReplay(r) };
    decoded.set(entry.id, r);
    const next = addRecent(load(), entry);
    memory = next;
    lastId = entry.id;
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* quota or blocked: still in memory for this tab */
    }
    return entry;
  } catch {
    return null;
  }
}

/** The match that just ended had no replay (forfeited): forget the previous one. */
export function clearLastReplay(): void {
  lastId = null;
}

export interface RecentReplay {
  id: string;
  code: string;
  replay: Replay;
}

function open(e: StoredReplay): RecentReplay | null {
  let replay = decoded.get(e.id);
  if (!replay) {
    try {
      replay = decodeReplay(e.code);
    } catch {
      return null;
    }
    decoded.set(e.id, replay);
  }
  return { id: e.id, code: e.code, replay };
}

/** Newest first. Entries that no longer decode are skipped. */
export function recentReplays(): RecentReplay[] {
  const out: RecentReplay[] = [];
  for (const e of [...load()].reverse()) {
    const r = open(e);
    if (r) out.push(r);
  }
  return out;
}

export function findReplay(id: string): RecentReplay | null {
  const e = load().find((x) => x.id === id);
  return e ? open(e) : null;
}

export function lastReplay(): RecentReplay | null {
  return lastId ? findReplay(lastId) : null;
}
