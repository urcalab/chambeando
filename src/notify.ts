import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { now, rowToUser, type Job, type User } from "./db.ts";

const money = (n: number) => `$${n.toLocaleString("es-419")}`;

const MODALITY_LABEL: Record<string, string | null> = { presencial: null, hibrido: "híbrido", remoto: "remoto" };

export function formatJob(j: Job, n?: number): string {
  const place = [j.company, j.location, MODALITY_LABEL[j.modality ?? "presencial"]].filter(Boolean).join(" · ");
  return [
    `${n ? `${n}. ` : ""}*${j.title}*`,
    place,
    j.salary ? `Sueldo: ${money(j.salary)}` : null,
    j.url,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatMessage(jobs: Job[]): string {
  const head = jobs.length === 1 ? "Encontré un aviso nuevo para ti:" : `Encontré ${jobs.length} avisos nuevos para ti:`;
  return [head, ...jobs.map((j, i) => formatJob(j, i + 1)), "Si alguno no te sirve, dime cuál y por qué, y afino la búsqueda."].join("\n\n");
}

export type SendResult = "sent" | "template" | "outside_window" | "failed";

/** Manda un mensaje por la API de servidor de Vatio. `template` solo se usa si la ventana de 24 h está cerrada. */
export type Sender = (msg: {
  to: string;
  text: string;
  brief: string;
  key: string;
  template?: { name: string; language: string; params: string[] };
}) => Promise<{ status: number; mode?: string; code?: string; message?: string }>;

export const vatioSender: Sender = async ({ to, text, brief, key, template }) => {
  const res = await fetch(`${config.vatio.baseUrl}/api/server/v1/${config.vatio.workspace}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.vatio.serverKey}`,
      "idempotency-key": key,
    },
    body: JSON.stringify({ to, text, brief, ...(template ? { template } : {}) }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, mode: body.mode, code: body.error?.code, message: body.error?.message };
};

const DAY = 86_400_000;

/**
 * Manda a cada persona sus avisos pendientes.
 * - Ventana abierta: van como texto y quedan `sent`.
 * - Ventana cerrada: una plantilla como máximo cada 24 h; los avisos siguen `pending`
 *   hasta que la persona responde y el agente los entrega con `avisos_pendientes`.
 */
export async function notifyAll(db: DatabaseSync, send: Sender): Promise<Record<SendResult, number> & { errors: string[] }> {
  const out = { sent: 0, template: 0, outside_window: 0, failed: 0, errors: [] as string[] };
  const phones = db
    .prepare(
      `SELECT DISTINCT d.phone FROM deliveries d JOIN users u ON u.phone = d.phone
       WHERE d.status = 'pending' AND u.active = 1`,
    )
    .all() as Array<{ phone: string }>;
  for (const { phone } of phones) {
    const user = rowToUser(db.prepare("SELECT * FROM users WHERE phone = ?").get(phone) as any);
    const jobs = pendingJobs(db, phone, config.maxJobsPerMessage);
    if (!jobs.length) continue;
    try {
      const result = await sendTo(db, user, jobs, send);
      out[result]++;
    } catch (e) {
      out.failed++;
      out.errors.push((e as Error).message);
    }
  }
  return out;
}

export function pendingJobs(db: DatabaseSync, phone: string, limit: number): Job[] {
  return db
    .prepare(
      `SELECT j.* FROM deliveries d JOIN jobs j ON j.id = d.job_id
       WHERE d.phone = ? AND d.status = 'pending' ORDER BY d.score DESC LIMIT ?`,
    )
    .all(phone, limit)
    .map((r: any) => {
      const { embedding: _e, ...job } = r;
      return job as Job;
    });
}

export function markSent(db: DatabaseSync, phone: string, jobIds: string[]): void {
  const stmt = db.prepare(
    `INSERT INTO deliveries (phone, job_id, status, created_at, sent_at) VALUES (?, ?, 'sent', ?, ?)
     ON CONFLICT (phone, job_id) DO UPDATE SET status = 'sent', sent_at = excluded.sent_at`,
  );
  const t = now();
  for (const id of jobIds) stmt.run(phone, id, t, t);
}

async function sendTo(db: DatabaseSync, user: User, jobs: Job[], send: Sender): Promise<SendResult> {
  const text = formatMessage(jobs);
  const brief = `Avisos de trabajo nuevos que calzan con lo que busca esta persona:\n${jobs
    .map((j) => `- ${j.id}: ${j.title} (${j.company ?? "empresa confidencial"}, ${j.location ?? "?"}) ${j.url}`)
    .join("\n")}`.slice(0, 2000);
  const key = createHash("sha256").update(`${user.phone}|${jobs.map((j) => j.id).join(",")}`).digest("hex").slice(0, 32);

  const first = await send({ to: user.phone, text, brief, key });
  if (first.status === 200 || first.status === 202) {
    markSent(db, user.phone, jobs.map((j) => j.id));
    return "sent";
  }
  if (first.code === "opted_out") {
    db.prepare("UPDATE users SET active = 0, updated_at = ? WHERE phone = ?").run(now(), user.phone);
    return "failed";
  }
  if (first.code !== "outside_window") throw new Error(`Vatio ${first.status} ${first.code ?? ""}: ${first.message ?? ""}`);

  const lastTemplate = user.last_template_at ? Date.parse(user.last_template_at) : 0;
  if (Date.now() - lastTemplate < DAY) return "outside_window";

  const total = (db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE phone = ? AND status = 'pending'").get(user.phone) as { n: number }).n;
  const second = await send({
    to: user.phone,
    text,
    brief,
    key: `${key}-t`,
    template: {
      name: config.vatio.template,
      language: "es",
      params: [String(total), jobs[0]!.title.slice(0, 80)],
    },
  });
  if (second.status !== 200 && second.status !== 202) {
    throw new Error(`Vatio ${second.status} ${second.code ?? ""}: ${second.message ?? ""}`);
  }
  db.prepare("UPDATE users SET last_template_at = ? WHERE phone = ?").run(now(), user.phone);
  return "template";
}
