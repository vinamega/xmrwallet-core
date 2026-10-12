import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../src/auth/ratelimit.js";
import { hashPassword, verifyPassword } from "../../src/auth/passwords.js";
import { scrub } from "../../src/logging.js";

describe("RateLimiter", () => {
  it("allows up to limit, then blocks", () => {
    const rl = new RateLimiter(3, 10 ** 9);
    expect(rl.allow("k")).toBe(true);
    expect(rl.allow("k")).toBe(true);
    expect(rl.allow("k")).toBe(true);
    expect(rl.allow("k")).toBe(false);
    expect(rl.allow("other")).toBe(true);
  });
});

describe("passwords (scrypt)", () => {
  it("hash + verify", () => {
    const h = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
  });

  it("unique salts", () => {
    expect(hashPassword("x")).not.toBe(hashPassword("x"));
  });
});

describe("log scrubbing", () => {
  it("scrubs monero addresses", () => {
    const addr = "55P1V8DvMrab3xzKDtJMeVVLhsFtjKCpqVeS4njj4X6XFEkoGwCWYmTjjm8BfRJS9eEFKvMdLwtzpb5rwsmHtzoT3eUT2tn";
    expect(scrub(`sending to ${addr} now`)).not.toContain(addr);
    expect(scrub(`sending to ${addr} now`)).toContain("[ADDR]");
  });

  it("scrubs 25-word mnemonics", () => {
    const words = Array.from({ length: 25 }, (_, i) => ["juice","atom","zebra","fjord","quilt","vixen","mango","prow","kiosk","lunar","oasis","brisk","cove"][i % 13]).join(" ");
    const s = scrub(`seed is ${words} ok`);
    expect(s).not.toContain("juice atom zebra");
    expect(s).toContain("[SEED]");
  });
});
