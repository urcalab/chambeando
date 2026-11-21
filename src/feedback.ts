import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { now, type Job } from "./db.ts";

/**
 * El token del link a un aviso para una persona: el mismo par persona y aviso da siempre el mismo token,
 * así que el link se puede armar antes de guardar la entrega. No contiene el teléfono ni se puede revertir.
 */
export function linkToken(phone: string, jobId: string): string {
  return createHmac("sha256", config.backendApiKey || "dev").update(`${phone}|${jobId}`).digest("base64url").slice(0, 12);
}

/** El link que ve la persona: pasa por /r/<token> para contar el clic y redirige al aviso original. */
export function jobLink(phone: string, job: Pick<Job, "id" | "url">): string {
  return config.publicUrl ? `${config.publicUrl}/r/${linkToken(phone, job.id)}` : job.url;
}

/** Registra un clic y devuelve la URL original, o null si el token no existe o el aviso ya se borró. */
export function recordClick(db: DatabaseSync, token: string): string | null {
  const row = db
    .prepare("SELECT d.phone, d.job_id, j.url FROM deliveries d JOIN jobs j ON j.id = d.job_id WHERE d.token = ?")
    .get(token) as { phone: string; job_id: string; url: string } | undefined;
  if (!row) return null;
  db.prepare(
    "UPDATE deliveries SET clicks = clicks + 1, first_click_at = COALESCE(first_click_at, ?) WHERE phone = ? AND job_id = ?",
  ).run(now(), row.phone, row.job_id);
  return row.url;
}

const pct = (part: number, total: number) => (total ? Math.round((part / total) * 1000) / 10 : null);

/**
 * Qué tan buenas están siendo las recomendaciones en los últimos `days` días, de la señal más débil a la más fuerte:
 * se mostró, la persona abrió el link, dijo que le sirvió, postuló.
 */
export function stats(db: DatabaseSync, days = 7) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...(args as [])) as T;
  const all = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(...(args as [])) as T[];

  const users = one<{ total: number; active: number; first_job: number }>(
    "SELECT COUNT(*) total, COALESCE(SUM(active), 0) active, COALESCE(SUM(first_job = 1), 0) first_job FROM users",
  );
  const funnel = one<Record<string, number>>(
    `SELECT COUNT(*) evaluated,
            COALESCE(SUM(status = 'rejected'), 0) rejected,
            COALESCE(SUM(status = 'sent'), 0) sent,
            COALESCE(SUM(status = 'sent' AND clicks > 0), 0) clicked,
            COALESCE(SUM(useful IS NOT NULL), 0) rated,
            COALESCE(SUM(useful = 1), 0) useful,
            COALESCE(SUM(applied = 1), 0) applied
     FROM deliveries WHERE created_at >= ?`,
    since,
  );
  const bySource = all<Record<string, unknown>>(
    `SELECT j.source, j.country, COUNT(*) sent, COALESCE(SUM(d.clicks > 0), 0) clicked,
            COALESCE(SUM(d.useful = 1), 0) useful, COALESCE(SUM(d.useful = 0), 0) not_useful, COALESCE(SUM(d.applied = 1), 0) applied
     FROM deliveries d JOIN jobs j ON j.id = d.job_id
     WHERE d.status = 'sent' AND d.created_at >= ? GROUP BY 1, 2 ORDER BY sent DESC`,
    since,
  );
  const complaints = all<{ title: string; feedback: string }>(
    `SELECT j.title, d.feedback FROM deliveries d JOIN jobs j ON j.id = d.job_id
     WHERE d.useful = 0 AND d.feedback IS NOT NULL AND d.created_at >= ? ORDER BY d.sent_at DESC LIMIT 20`,
    since,
  );
  return {
    days,
    users,
    funnel: {
      ...funnel,
      rejected_pct: pct(funnel.rejected!, funnel.evaluated!),
      click_pct: pct(funnel.clicked!, funnel.sent!),
      rated_pct: pct(funnel.rated!, funnel.sent!),
      useful_pct: pct(funnel.useful!, funnel.rated!),
      applied_pct: pct(funnel.applied!, funnel.sent!),
    },
    by_source: bySource,
    complaints,
  };
}
