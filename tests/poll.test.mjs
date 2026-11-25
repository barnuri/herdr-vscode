import { test } from "node:test";
import assert from "node:assert/strict";
import { PollPacer, stalest } from "../shared/poll-core.js";

test("PollPacer starts at the base and grows while nothing changes", () => {
  const pacer = new PollPacer({ baseMs: 4000, maxMs: 30000 });
  assert.equal(pacer.nextMs(), 4000);
  pacer.note({ changed: false, tookMs: 50 });
  assert.equal(pacer.nextMs(), 6400);
  pacer.note({ changed: false, tookMs: 50 });
  assert.equal(pacer.nextMs(), 10240);
});

test("PollPacer stops growing at the maximum", () => {
  const pacer = new PollPacer({ baseMs: 4000, maxMs: 30000 });
  for (let i = 0; i < 20; i++) {
    pacer.note({ changed: false, tookMs: 50 });
  }
  assert.equal(pacer.nextMs(), 30000);
});

test("PollPacer snaps back to the base when the result changes, and on reset", () => {
  const pacer = new PollPacer({ baseMs: 4000, maxMs: 30000 });
  pacer.note({ changed: false, tookMs: 50 });
  pacer.note({ changed: true, tookMs: 50 });
  assert.equal(pacer.nextMs(), 4000);
  pacer.note({ changed: false, tookMs: 50 });
  pacer.reset();
  assert.equal(pacer.nextMs(), 4000);
});

test("PollPacer waits at least loadFactor times a slow run", () => {
  const pacer = new PollPacer({ baseMs: 4000, maxMs: 60000, loadFactor: 10 });
  pacer.note({ changed: true, tookMs: 2500 });
  assert.equal(pacer.nextMs(), 25000);
  pacer.note({ changed: true, tookMs: 9000 });
  assert.equal(pacer.nextMs(), 60000);
});

test("PollPacer keeps the maximum at or above the base", () => {
  const pacer = new PollPacer({ baseMs: 5000, maxMs: 1000 });
  assert.equal(pacer.nextMs(), 5000);
});

test("stalest picks never-fetched keys first, then the oldest, up to the limit", () => {
  const fetchedAt = new Map([["a", 9000], ["b", 1000], ["c", 5000]]);
  assert.deepEqual(stalest(["a", "b", "c", "d"], fetchedAt, 10000, 2, 0), ["d", "b"]);
});

test("stalest skips keys younger than the minimum age", () => {
  const fetchedAt = new Map([["a", 9500], ["b", 1000]]);
  assert.deepEqual(stalest(["a", "b"], fetchedAt, 10000, 3, 2000), ["b"]);
  assert.deepEqual(stalest(["a"], fetchedAt, 10000, 3, 2000), []);
});
