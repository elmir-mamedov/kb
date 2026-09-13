/**
 * Lockout for repeated failed sign-ins.
 *
 * The viewer has exactly one account, so an unthrottled login form is a
 * password oracle: a caller can guess at whatever rate the network allows.
 * Tripping a cooldown after a handful of wrong answers turns online guessing
 * into something slower than it is worth, without touching the password itself.
 *
 * Counted per client rather than globally, so one person fat-fingering their
 * password cannot lock everyone else out. The trade is the usual one: a caller
 * spread across many addresses is throttled per address rather than in
 * aggregate, and enough distinct addresses to overflow `maxClients` evict each
 * other's records. Both are acceptable for a viewer that is meant to stay on
 * loopback; neither is a reason to leave the form unthrottled.
 *
 * State is in memory and per process, so a restart forgives every client. That
 * is the right trade for a single-process local viewer — persisting lockouts
 * would buy little and hand a caller a way to write to disk.
 */

export interface ThrottleOptions {
  /** Failures a client may make before the cooldown starts. */
  maxFailures?: number;
  /** How long a client that tripped the limit is refused. */
  lockoutMs?: number;
  /** Failures stop counting once a client has been quiet this long. */
  windowMs?: number;
  /** Clients tracked at once; the least recently seen are dropped first. */
  maxClients?: number;
}

/** Whether a client may attempt a sign-in, and how long it waits if not. */
export type ThrottleVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export interface LoginThrottle {
  /** Ask before checking the password; a refused attempt must not reach it. */
  check(key: string, now?: number): ThrottleVerdict;
  /** Record a wrong answer and report where it leaves the client. */
  recordFailure(key: string, now?: number): ThrottleVerdict;
  /** Clear a client's record; a correct password ends its cooldown. */
  recordSuccess(key: string): void;
  /** Clients currently tracked. Exposed for tests and eviction assertions. */
  size(): number;
}

interface Entry {
  failures: number;
  /** When the most recent failure landed. */
  last: number;
}

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_LOCKOUT_MS = 15 * 60_000;
const DEFAULT_WINDOW_MS = 15 * 60_000;
const DEFAULT_MAX_CLIENTS = 4096;

export function makeLoginThrottle(options: ThrottleOptions = {}): LoginThrottle {
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  const lockoutMs = options.lockoutMs ?? DEFAULT_LOCKOUT_MS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS;

  // Insertion order is touch order: every write re-inserts, so the front of the
  // map is the least recently seen client and eviction can just take from there.
  const clients = new Map<string, Entry>();

  /** How long a client's record outlives its last failure. */
  function lifetime(entry: Entry): number {
    return entry.failures >= maxFailures ? lockoutMs : windowMs;
  }

  /**
   * A client's live record, or null. Expiry is resolved on read rather than on a
   * timer: a served cooldown and a quiet window both end the same way, by
   * dropping the record so the client starts over with a full allowance.
   */
  function live(key: string, now: number): Entry | null {
    const entry = clients.get(key);
    if (!entry) return null;
    if (now - entry.last >= lifetime(entry)) {
      clients.delete(key);
      return null;
    }
    return entry;
  }

  function verdict(entry: Entry | null, now: number): ThrottleVerdict {
    if (!entry || entry.failures < maxFailures) return { allowed: true };
    const remainingMs = entry.last + lockoutMs - now;
    return { allowed: false, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
  }

  /** Keep the map bounded: expired records first, then the least recently seen. */
  function evict(now: number): void {
    if (clients.size <= maxClients) return;
    for (const [key, entry] of clients) {
      if (now - entry.last >= lifetime(entry)) clients.delete(key);
    }
    while (clients.size > maxClients) {
      const oldest = clients.keys().next();
      if (oldest.done) break;
      clients.delete(oldest.value);
    }
  }

  return {
    check(key, now = Date.now()) {
      return verdict(live(key, now), now);
    },

    recordFailure(key, now = Date.now()) {
      const entry = live(key, now) ?? { failures: 0, last: now };
      entry.failures += 1;
      entry.last = now;
      clients.delete(key);
      clients.set(key, entry);
      evict(now);
      return verdict(entry, now);
    },

    recordSuccess(key) {
      clients.delete(key);
    },

    size() {
      return clients.size;
    },
  };
}

/**
 * A wait in words, for the sentence the login page shows. Rounds up, so the
 * number a reader sees never expires before the cooldown it describes.
 */
export function retryAfterWords(retryAfterSeconds: number): string {
  if (retryAfterSeconds <= 60) return "less than a minute";
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return `${minutes} minutes`;
}
