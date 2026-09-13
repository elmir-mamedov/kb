import { test } from "node:test";
import assert from "node:assert/strict";
import { makeLoginThrottle, retryAfterWords } from "./login-throttle.js";

/** A fixed clock start, so every offset in a test reads as "ms since the first attempt". */
const T0 = 1_700_000_000_000;

const throttle = (overrides = {}) =>
  makeLoginThrottle({ maxFailures: 3, lockoutMs: 60_000, windowMs: 30_000, ...overrides });

test("a client may fail up to the limit before it is refused", () => {
  const t = throttle();
  assert.deepEqual(t.check("a", T0), { allowed: true });
  assert.deepEqual(t.recordFailure("a", T0), { allowed: true });
  assert.deepEqual(t.recordFailure("a", T0 + 1), { allowed: true });
  assert.deepEqual(t.check("a", T0 + 2), { allowed: true });
});

test("the failure that reaches the limit locks the client out", () => {
  const t = throttle();
  t.recordFailure("a", T0);
  t.recordFailure("a", T0);
  const tripped = t.recordFailure("a", T0);
  assert.deepEqual(tripped, { allowed: false, retryAfterSeconds: 60 });
  assert.deepEqual(t.check("a", T0 + 1_000), { allowed: false, retryAfterSeconds: 59 });
});

test("the countdown rounds up, so it never reads as over while it is running", () => {
  const t = throttle();
  for (let i = 0; i < 3; i += 1) t.recordFailure("a", T0);
  const verdict = t.check("a", T0 + 59_001);
  assert.deepEqual(verdict, { allowed: false, retryAfterSeconds: 1 });
});

test("a served lockout ends and returns the client a full allowance", () => {
  const t = throttle();
  for (let i = 0; i < 3; i += 1) t.recordFailure("a", T0);
  assert.deepEqual(t.check("a", T0 + 60_000), { allowed: true });
  // Fresh count, not one wrong answer away from another lockout.
  assert.deepEqual(t.recordFailure("a", T0 + 60_000), { allowed: true });
  assert.deepEqual(t.recordFailure("a", T0 + 60_000), { allowed: true });
  assert.equal(t.recordFailure("a", T0 + 60_000).allowed, false);
});

test("failures spaced beyond the window never accumulate into a lockout", () => {
  const t = throttle();
  assert.deepEqual(t.recordFailure("a", T0), { allowed: true });
  assert.deepEqual(t.recordFailure("a", T0 + 30_000), { allowed: true });
  assert.deepEqual(t.recordFailure("a", T0 + 60_000), { allowed: true });
  assert.deepEqual(t.recordFailure("a", T0 + 90_000), { allowed: true });
});

test("a correct password clears the client's record", () => {
  const t = throttle();
  t.recordFailure("a", T0);
  t.recordFailure("a", T0);
  t.recordSuccess("a");
  assert.equal(t.size(), 0);
  assert.deepEqual(t.recordFailure("a", T0), { allowed: true });
});

test("one client's lockout leaves another client alone", () => {
  const t = throttle();
  for (let i = 0; i < 3; i += 1) t.recordFailure("a", T0);
  assert.equal(t.check("a", T0).allowed, false);
  assert.deepEqual(t.check("b", T0), { allowed: true });
});

test("the tracked set stays bounded, dropping the least recently seen client", () => {
  const t = throttle({ maxClients: 2 });
  t.recordFailure("a", T0);
  t.recordFailure("b", T0 + 1);
  t.recordFailure("c", T0 + 2);
  // "a" was the least recently seen, so it went; "b" kept the failure it had.
  assert.equal(t.size(), 2);
  assert.equal(t.recordFailure("b", T0 + 3).allowed, true);
  assert.equal(t.recordFailure("b", T0 + 4).allowed, false);
});

test("expired records are dropped before a live one is evicted", () => {
  const t = throttle({ maxClients: 2 });
  t.recordFailure("stale", T0);
  t.recordFailure("b", T0 + 30_001);
  // "stale" is past its window by now, so it goes and "b" survives.
  t.recordFailure("c", T0 + 30_002);
  assert.equal(t.size(), 2);
  // "b" survived with its failure intact, so two more reach the limit.
  assert.equal(t.recordFailure("b", T0 + 30_003).allowed, true);
  assert.equal(t.recordFailure("b", T0 + 30_004).allowed, false);
});

test("a wait reads in whole minutes, rounded up", () => {
  assert.equal(retryAfterWords(1), "less than a minute");
  assert.equal(retryAfterWords(60), "less than a minute");
  assert.equal(retryAfterWords(61), "2 minutes");
  assert.equal(retryAfterWords(900), "15 minutes");
});
