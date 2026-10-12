// Scrubbing-safe logger: no seeds, mnemonics, or addresses may ever reach a log.
// scrub() defensively rewrites obvious wallet secrets in dynamic strings.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

let threshold: number = LEVELS[("info") as LogLevel];

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

// Standard Monero address: 95 or 106 base58 chars.
const ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{95}(?:[1-9A-HJ-NP-Za-km-z]{11})?\b/g;
// Mnemonic-ish: 13/25 short lowercase words separated by single spaces.
const WORD = "[a-z]{3,12}";
const MNEMONIC_RE = new RegExp(`\\b(?:${WORD}(?: ${WORD}){11}|${WORD}(?: ${WORD}){24})\\b`, "g");

export function scrub(input: string): string {
  return input.replace(MNEMONIC_RE, "[SEED]").replace(ADDRESS_RE, "[ADDR]");
}

function emit(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = {
    t: new Date().toISOString(),
    level,
    msg: scrub(msg),
    ...(extra ? { extra: scrubValues(extra) } : {}),
  };
  const out = level === "error" ? console.error : console.log;
  out(JSON.stringify(line));
}

function scrubValues(extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) out[k] = typeof v === "string" ? scrub(v) : v;
  return out;
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => emit("debug", msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => emit("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit("error", msg, extra),
};
