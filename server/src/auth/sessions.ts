import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";

export interface SessionUser {
  id: string;
  email: string | null;
  isAnon: boolean;
}

export const COOKIE_NAME = "mws";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(db: Pool, userId: string, ttlDays: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000);
  await db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [
    hashToken(token),
    userId,
    expiresAt,
  ]);
  return token;
}

export async function resolveSession(db: Pool, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const res = await db.query(
    `SELECT s.token_hash, u.id, u.email, u.is_anon
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { id: row.id as string, email: (row.email as string | null) ?? null, isAnon: row.is_anon as boolean };
}

export async function destroySession(db: Pool, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function sessionCookie(token: string, secure: boolean): string {
  const attrs = ["HttpOnly", "SameSite=Strict", "Path=/", `Max-Age=${7 * 24 * 3600}`];
  if (secure) attrs.push("Secure");
  return `${COOKIE_NAME}=${token}; ${attrs.join("; ")}`;
}

export function clearSessionCookie(secure: boolean): string {
  const attrs = ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return `${COOKIE_NAME}=; ${attrs.join("; ")}`;
}

export { timingSafeEqual };
