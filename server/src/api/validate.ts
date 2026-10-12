// Input validation regexes (structural only; the engine validates for real).

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Atomic amounts: decimal digits, up to 19 chars (< 2^63), no sign.
export const AMOUNT_RE = /^\d{1,19}$/;

// Standard (95) or integrated (106) Monero address, base58.
export const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{95}(?:[1-9A-HJ-NP-Za-km-z]{11})?$/;
