import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { fromBlob, fromBlobs, now, rowToUser, toBlobs, type Job, type User } from "./db.ts";
import { dot, type Embedder } from "./embed.ts";
import type { Judge, PastFeedback } from "./llm.ts";
import { acceptedModalities, daysSincePublished, jobKind, modalityRegionOk, normalize, regionMatches } from "./text.ts";

const KIND_WORDS = { practica: "práctica profesional", part_time: "part-time, medio tiempo", full_time: "tiempo completo" };

export function userText(u: Pick<User, "roles" | "summary" | "studies" | "first_job" | "job_kinds">): string {
  return [
    u.roles.join(", "),
    u.summary,
    u.studies ? `Estudios: ${u.studies}` : "",
    u.first_job ? "Primer trabajo, sin experiencia, junior" : "",
    u.job_kinds.map((k) => KIND_WORDS[k]).join(", "),
  ]
    .filter(Boolean)
    .join(". ");
}

/**
 * Filtros duros: solo descartan cuando el aviso dice explícitamente algo que la persona no quiere.
 * Un dato que el aviso no informa (región, modalidad, sueldo) no descarta.
 */
export function passesFilters(
  user: Pick<User, "regions" | "modalities" | "modality_regions" | "min_salary" | "exclude" | "job_kinds">,
  job: Pick<Job, "title" | "region" | "modality" | "salary" | "job_type">,
): boolean {
  const kind = jobKind(job.job_type, job.title);
  if (user.job_kinds.length && kind && !user.job_kinds.includes(kind)) return false;
  if (user.regions.length && job.region && job.modality !== "remoto" && !regionMatches(user.regions, job.region)) {
    return false;
  }
  if (user.modalities.length && job.modality && !acceptedModalities(user.modalities).includes(job.modality)) return false;
  if (job.modality && job.region && !modalityRegionOk(user, job.modality, job.region)) return false;
  if (user.min_salary && job.salary && job.salary < user.min_salary) return false;
  const title = ` ${normalize(job.title)} `;
  if (user.exclude.some((x) => normalize(x) && title.includes(` ${normalize(x)} `))) return false;
  return true;
}

export type Scored = { job: Job; score: number };

/**
 * Un aviso publicado hace más de 3 meses que sigue abierto casi siempre es una búsqueda permanente (consultoras que
 * dejan el mismo aviso todo el año). No se descarta, porque la fecha la informa cada portal a su manera, pero pierde
 * frente a los recientes: la diferencia de parecido entre los candidatos de una persona suele ser de centésimas.
 */
export const STALE_DAYS = 90;
export const STALE_PENALTY = 0.03;

/**
 * Con qué se buscan avisos para una persona: un vector por cada uno de sus cargos, o el del perfil entero si no dijo
 * cargos. Con el del perfil, los cargos de quien busca varias cosas se promediaban, y el resumen (sueldo, lugar,
 * modalidad, que ya filtran los filtros duros) pesaba más que el trabajo: a una historiadora que buscaba archivo o
 * administración le salían avisos de desarrollo, que se parecen un poco a todo. Sumar el del perfil a los de los
 * cargos no lo arregla, porque esos avisos le siguen ganando por parecido con el perfil.
 */
export function queriesOf(r: { embedding: Uint8Array; role_embeddings?: Uint8Array | null }): Float32Array[] {
  const profile = fromBlob(r.embedding);
  return r.role_embeddings?.length ? fromBlobs(r.role_embeddings, profile.length) : [profile];
}

/** Calcula los vectores por cargo de quien todavía no los tiene (perfiles guardados antes de que existieran). */
export async function fillRoleVectors(db: DatabaseSync, embed: Embedder): Promise<number> {
  // Sin cargos no hay nada que calcular (y SQLite guarda el blob vacío como NULL).
  const rows = db.prepare("SELECT phone, roles FROM users WHERE role_embeddings IS NULL AND roles != '[]'").all() as Array<{ phone: string; roles: string }>;
  const save = db.prepare("UPDATE users SET role_embeddings = ? WHERE phone = ?");
  for (const r of rows) save.run(toBlobs(await embed(JSON.parse(r.roles) as string[], "query")), r.phone);
  return rows.length;
}

/**
 * Los avisos más parecidos a la persona que pasan los filtros y que todavía no recibió. Cada aviso vale lo que su
 * mejor parecido con `queries` (ver `queriesOf`), menos `STALE_PENALTY` si es viejo.
 */
export function rank(
  db: DatabaseSync,
  user: User,
  queries: Float32Array[],
  opts: { since?: string; limit: number; skipStatuses: string[] },
): Scored[] {
  const marks = opts.skipStatuses.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT j.* FROM jobs j
       WHERE j.country = ? AND j.first_seen_at > ? AND j.duplicate_of IS NULL AND j.embedding IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM deliveries d
                         WHERE d.phone = ? AND d.job_id = j.id AND d.status IN (${marks}))`,
    )
    .all(user.country, opts.since ?? "", user.phone, ...opts.skipStatuses) as Array<Job & { embedding: Uint8Array }>;
  const scored: Scored[] = [];
  for (const row of rows) {
    if (!passesFilters(user, row)) continue;
    const { embedding, ...job } = row;
    const v = fromBlob(embedding);
    const stale = (daysSincePublished(job.published_at, user.country) ?? 0) > STALE_DAYS;
    scored.push({ job, score: Math.max(...queries.map((q) => dot(q, v))) - (stale ? STALE_PENALTY : 0) });
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
    (r) => ({ user: rowToUser(r), queries: queriesOf(r) }),
  );
  const record = db.prepare(
    `INSERT OR IGNORE INTO deliveries (phone, job_id, score, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const advance = db.prepare("UPDATE users SET matched_until = ? WHERE phone = ?");
  let pending = 0;
  const errors: string[] = [];
  for (const { user, queries } of users) {
    const startedAt = now();
    const candidates = rank(db, user, queries, {
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
