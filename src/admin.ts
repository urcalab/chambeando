import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { now, rowToUser } from "./db.ts";
import { stats } from "./feedback.ts";

/**
 * Consola de admin: solo lectura, con su propia clave (ADMIN_API_KEY), distinta de la que usa Vatio.
 * Los teléfonos nunca salen completos: se identifican por un hash y se muestran enmascarados.
 */

/** Identificador estable de una persona que no revela su número. */
export function phoneId(phone: string): string {
  return createHmac("sha256", config.backendApiKey || "dev").update(`phone|${phone}`).digest("hex").slice(0, 16);
}

/** "+56948454110" -> "+56 9 •••• 4110". */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `+${digits.slice(0, 2)} ${digits.slice(2, 3)} •••• ${digits.slice(-4)}`;
}

const DAY = 86_400_000;
const since = (days: number) => new Date(Date.now() - days * DAY).toISOString();
type Row = Record<string, unknown>;

export function createAdmin(db: DatabaseSync) {
  const all = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...(args as [])) as Row[];
  const one = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...(args as [])) as Row;

  function findUser(id: string) {
    for (const r of all("SELECT * FROM users")) if (phoneId(r.phone as string) === id) return r;
    return null;
  }

  return {
    /** Resumen, embudo y series por día de los últimos `days` días. */
    overview(days: number) {
      const from = since(days);
      const daily = all(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS evaluated,
                COALESCE(SUM(status = 'rejected'), 0) AS rejected, COALESCE(SUM(status = 'sent'), 0) AS sent,
                COALESCE(SUM(clicks > 0), 0) AS clicked, COALESCE(SUM(useful = 1), 0) AS useful,
                COALESCE(SUM(applied = 1), 0) AS applied
         FROM deliveries WHERE created_at >= ? GROUP BY 1 ORDER BY 1`,
        from,
      );
      const newUsers = all("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS users FROM users WHERE created_at >= ? GROUP BY 1 ORDER BY 1", from);
      const newJobs = all(
        `SELECT substr(first_seen_at, 1, 10) AS day, COUNT(*) AS jobs, COALESCE(SUM(duplicate_of IS NOT NULL), 0) AS duplicates
         FROM jobs WHERE first_seen_at >= ? GROUP BY 1 ORDER BY 1`,
        from,
      );
      return {
        generated_at: now(),
        ...stats(db, days),
        users_by_country: all("SELECT country, COUNT(*) AS users, COALESCE(SUM(active), 0) AS active FROM users GROUP BY 1 ORDER BY 2 DESC"),
        jobs_by_country: all(
          "SELECT country, COUNT(*) AS jobs, COALESCE(SUM(duplicate_of IS NULL), 0) AS unique_jobs FROM jobs GROUP BY 1 ORDER BY 2 DESC",
        ),
        daily: { deliveries: daily, new_users: newUsers, new_jobs: newJobs },
        last_run: this.runs(1)[0] ?? null,
      };
    },

    /** Estado de cada fuente: cuántos avisos tiene, cuántos llegaron en 24 h y cómo le fue en la última corrida. */
    sources() {
      const last = this.runs(1)[0]?.ingested as Record<string, Row> | undefined;
      const rows = all(
        `SELECT source, country, COUNT(*) AS jobs, COALESCE(SUM(first_seen_at >= ?), 0) AS last_24h,
                COALESCE(SUM(duplicate_of IS NOT NULL), 0) AS duplicates, MAX(first_seen_at) AS newest
         FROM jobs GROUP BY 1, 2 ORDER BY 3 DESC`,
        since(1),
      );
      return { last_run: last ?? null, by_source: rows };
    },

    /** Personas, sin su número. */
    users(limit: number) {
      return all(
        `SELECT u.*, (SELECT COUNT(*) FROM deliveries d WHERE d.phone = u.phone AND d.status = 'sent') AS sent,
                (SELECT COUNT(*) FROM deliveries d WHERE d.phone = u.phone AND d.clicks > 0) AS clicked,
                (SELECT COUNT(*) FROM deliveries d WHERE d.phone = u.phone AND d.useful = 1) AS useful,
                (SELECT COUNT(*) FROM deliveries d WHERE d.phone = u.phone AND d.useful = 0) AS not_useful,
                (SELECT MAX(sent_at) FROM deliveries d WHERE d.phone = u.phone) AS last_sent_at
         FROM users u ORDER BY u.created_at DESC LIMIT ?`,
        limit,
      ).map((r) => {
        const u = rowToUser(r);
        return {
          id: phoneId(u.phone), phone: maskPhone(u.phone), country: u.country, summary: u.summary, studies: u.studies,
          first_job: u.first_job, job_kinds: u.job_kinds, roles: u.roles, regions: u.regions, active: u.active,
          created_at: r.created_at, updated_at: r.updated_at, sent: r.sent, clicked: r.clicked, useful: r.useful,
          not_useful: r.not_useful, last_sent_at: r.last_sent_at,
        };
      });
    },

    /** Una persona y cada aviso que se evaluó para ella. */
    user(id: string) {
      const r = findUser(id);
      if (!r) return null;
      const u = rowToUser(r);
      const deliveries = all(
        `SELECT d.status, d.score, d.reason, d.clicks, d.useful, d.applied, d.feedback, d.created_at, d.sent_at,
                j.id AS job_id, j.title, j.company, j.location, j.source, j.url
         FROM deliveries d LEFT JOIN jobs j ON j.id = d.job_id WHERE d.phone = ? ORDER BY d.created_at DESC LIMIT 200`,
        u.phone,
      );
      const { phone: _p, ...profile } = u;
      return { id, phone: maskPhone(u.phone), profile, created_at: r.created_at, updated_at: r.updated_at, deliveries };
    },

    /** Corridas horarias, de la más nueva a la más vieja. */
    runs(limit: number) {
      return all("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT ?", limit).map((r) => ({
        id: r.id, started_at: r.started_at, finished_at: r.finished_at, error: r.error,
        ...(JSON.parse((r.result as string) || "{}") as Row),
      }));
    },

    /** Registro forense de llamadas a la API. */
    log(opts: { limit: number; path?: string; caller?: string; status?: number }) {
      const where: string[] = [];
      const args: unknown[] = [];
      if (opts.path) (where.push("path LIKE ?"), args.push(`${opts.path}%`));
      if (opts.caller) (where.push("caller = ?"), args.push(opts.caller));
      if (opts.status) (where.push("status = ?"), args.push(opts.status));
      return all(
        `SELECT * FROM api_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
        ...args,
        opts.limit,
      );
    },

    ping: () => one("SELECT COUNT(*) AS jobs FROM jobs"),
  };
}

/** Registra una llamada. Append-only: la API no tiene forma de editar ni borrar estas filas. */
export function logCall(
  db: DatabaseSync,
  e: { method: string; path: string; status: number; ms: number; caller: string; ip: string | null; phone?: string | null; error?: string | null },
) {
  db.prepare(
    `INSERT INTO api_log (at, method, path, status, ms, caller, ip, phone_id, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(now(), e.method, e.path.slice(0, 200), e.status, Math.round(e.ms), e.caller, e.ip, e.phone ? phoneId(e.phone) : null, e.error?.slice(0, 300) ?? null);
}
