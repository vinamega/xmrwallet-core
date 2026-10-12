// Async mutex + per-key mutex set.
// The wallet manager's per-wallet mutex guarantees a wallet is never touched
// by two workers at once (guide §2).

export class Mutex {
  private chain: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.chain;
    let release: () => void;
    this.chain = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release!();
    }
  }
}

// Run fn while holding the mutex, but only if it can be acquired within
// `timeoutMs` (used to serialize chain-pool-touching refreshes without
// letting a slow holder back up the watch loop).
export async function runWithTimeout<T>(
  mutex: Mutex,
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T | "timeout"> {
  let acquired = false;
  const gate = mutex.run(async () => {
    acquired = true;
    return await fn();
  });
  const timer = new Promise<"timeout">((r) =>
    setTimeout(() => {
      if (!acquired) r("timeout");
    }, timeoutMs).unref(),
  );
  const res = await Promise.race([gate, timer]);
  return res;
}

export class KeyedMutexes {
  private mutexes = new Map<string, Mutex>();

  for(key: string): Mutex {
    let m = this.mutexes.get(key);
    if (!m) {
      m = new Mutex();
      this.mutexes.set(key, m);
    }
    return m;
  }
}
