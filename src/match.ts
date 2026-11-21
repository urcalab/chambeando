import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { fromBlob, now, rowToUser, type Job, type User } from "./db.ts";
import { dot } from "./embed.ts";
import type { Judge, PastFeedback } from "./llm.ts";
import { normalize } from "./text.ts";

export function userText(u: Pick<User, "roles" | "summary">): string {
  return [u.roles.join(", "), u.summary].filter(Boolean).join(". ");
}

/**
 * Filtros duros: solo descartan cuando el aviso dice explícitamente algo que la persona no quiere.
 * Un dato que el aviso no informa (región, modalidad, sueldo) no descarta.
 */
export function passesFilters(
  user: Pick<User, "regions" | "modalities" | "min_salary" | "exclude">,
  job: Pick<Job, "title" | "region" | "modality" | "salary">,
): boolean {
  if (user.regions.length && job.region && job.modality !== "remoto" && !regionMatches(user.regions, job.region)) {
    return false;
  }
  if (user.modalities.length && job.modality && !user.modalities.includes(job.modality)) return false;
  if (user.min_salary && job.salary && job.salary < user.min_salary) return false;
  const title = ` ${normalize(job.title)} `;
  if (user.exclude.some((x) => normalize(x) && title.includes(` ${normalize(x)} `))) return false;
  return true;
}

/** Igual, o una contiene a la otra: "lima" calza con "lima metropolitana". */
function regionMatches(wanted: string[], region: string): boolean {
  const r = ` ${region} `;
  return wanted.some((w) => w === region || r.includes(` ${w} `) || ` ${w} `.includes(r));
}

export type Scored = { job: Job; score: number };

/** Los avisos más parecidos a `vector` que pasan los filtros y que la persona todavía no recibió. */
export function rank(
  db: DatabaseSync,
  user: User,
  vector: Float32Array,
  opts: { since?: string; limit: number; skipStatuses: string[] },
): Scored[] {
  const marks = opts.skipStatuses.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT j.* FROM jobs j
       WHERE j.country = ? AND j.first_seen_at > ? AND j.embedding IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM deliveries d
                         WHERE d.phone = ? AND d.job_id = j.id AND d.status IN (${marks}))`,
    )
    .all(user.country, opts.since ?? "", user.phone, ...opts.skipStatuses) as Array<Job & { embedding: Uint8Array }>;
  const scored: Scored[] = [];
  for (const row of rows) {
    if (!passesFilters(user, row)) continue;
    const { embedding, ...job } = row;
    scored.push({ job, score: dot(vector, fromBlob(embedding)) });
  }
  scored.sort((a, b) => b.score - a.score);
  // Los portales republican el mismo aviso con otro id: se deja solo el primero de cada uno.
  const seen = new Set<string>();
  const unique: Scored[] = [];
  for (const s of scored) {
    const key = normalize(`${s.job.title}|${s.job.company ?? ""}|${s.job.location ?? ""}`);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(s);
    if (unique.length === opts.limit) break;
  }
  return unique;
}

export function pastFeedback(db: DatabaseSync, phone: string): PastFeedback[] {
  const rows = db
    .prepare(
      `SELECT j.title, d.useful, d.feedback FROM deliveries d JOIN jobs j ON j.id = d.job_id
       WHERE d.phone = ? AND d.useful IS NOT NULL ORDER BY d.sent_at DESC LIMIT 8`,
    )
    .all(phone) as Array<{ title: string; useful: number; feedback: string | null }>;
  return rows.map((r) => ({ title: r.title, useful: r.useful === 1, feedback: r.feedback }));
}

/**
 * Evalúa para cada persona activa los avisos que llegaron desde su última corrida y deja
 * como `pending` los que el modelo aprueba. Devuelve cuántos quedaron por mandar.
 */
export async function matchAll(db: DatabaseSync, judge: Judge | null): Promise<{ users: number; pending: number; errors: string[] }> {
  const users = (db.prepare("SELECT * FROM users WHERE active = 1 AND embedding IS NOT NULL").all() as any[]).map(
    (r) => ({ user: rowToUser(r), vector: fromBlob(r.embedding as Uint8Array) }),
  );
  const record = db.prepare(
    `INSERT OR IGNORE INTO deliveries (phone, job_id, score, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const advance = db.prepare("UPDATE users SET matched_until = ? WHERE phone = ?");
  let pending = 0;
  const errors: string[] = [];
  for (const { user, vector } of users) {
    const startedAt = now();
    const candidates = rank(db, user, vector, {
      since: user.matched_until,
      limit: config.candidatesPerUser,
      skipStatuses: ["pending", "sent", "rejected"],
    });
    if (candidates.length) {
      try {
        // Sin modelo configurado se mandan los 3 más parecidos, sin revisión.
        const verdicts = judge
          ? await judge(user, pastFeedback(db, user.phone), candidates.map((c) => c.job))
          : candidates.map((_, i) => ({ ok: i < 3, reason: "" }));
        candidates.forEach((c, i) => {
          const v = verdicts[i]!;
          record.run(user.phone, c.job.id, c.score, v.reason, v.ok ? "pending" : "rejected", now());
          if (v.ok) pending++;
        });
      } catch (e) {
        // No se avanza el cursor: estos avisos se vuelven a evaluar en la próxima corrida.
        errors.push(`${user.phone.slice(0, 5)}…: ${(e as Error).message}`);
        continue;
      }
    }
    advance.run(startedAt, user.phone);
  }
  return { users: users.length, pending, errors };
}
