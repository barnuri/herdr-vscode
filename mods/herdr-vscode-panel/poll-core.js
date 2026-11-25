// Pure rules for polling that must stay cheap on a loaded machine. Every git call is scanned by the
// endpoint security agents, so a fixed 4 s timer per mod added up to about 2.7 git processes per second.
//
//   PollPacer: the next delay grows while nothing changes, snaps back to the base when something
//   does, and never drops below `loadFactor` times the last run's duration, so a slow machine is
//   polled less without any load reading.
//   stalest: which keys to refresh in one pass, so many repos cannot start many processes at once.

const DEFAULT_GROWTH = 1.6;
const DEFAULT_LOAD_FACTOR = 10;

export class PollPacer {
  constructor({ baseMs, maxMs, growth = DEFAULT_GROWTH, loadFactor = DEFAULT_LOAD_FACTOR }) {
    this.baseMs = baseMs;
    this.maxMs = Math.max(maxMs, baseMs);
    this.growth = growth;
    this.loadFactor = loadFactor;
    this.unchanged = 0;
    this.tookMs = 0;
  }

  // Records one finished run: did the result change, and how long did the run take.
  note({ changed, tookMs }) {
    this.unchanged = changed ? 0 : this.unchanged + 1;
    this.tookMs = Math.max(0, tookMs);
  }

  // The user did something (focus moved, a repo was picked): poll at the base rate again.
  reset() {
    this.unchanged = 0;
  }

  nextMs() {
    const grown = this.baseMs * this.growth ** this.unchanged;
    const loaded = this.tookMs * this.loadFactor;
    return Math.round(Math.min(this.maxMs, Math.max(this.baseMs, grown, loaded)));
  }
}

// Up to `limit` keys to refresh now: never fetched first, then the oldest fetch that is at least
// `minAgeMs` old. `fetchedAt` maps key -> ms.
export function stalest(keys, fetchedAt, now, limit, minAgeMs) {
  return keys
    .map((key) => ({ key, age: fetchedAt.has(key) ? now - fetchedAt.get(key) : Infinity }))
    .filter((entry) => entry.age >= minAgeMs)
    .sort((a, b) => b.age - a.age)
    .slice(0, limit)
    .map((entry) => entry.key);
}
