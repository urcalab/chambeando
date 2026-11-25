import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { now, rowToUser, type Job, type User } from "./db.ts";
import { passesFilters } from "./match.ts";
import { localNow, publishedAgo } from "./text.ts";
import { jobLink, linkToken } from "./feedback.ts";

const money = (n: number) => `$${n.toLocaleString("es-419")}`;

const MODALITY_LABEL: Record<string, string | null> = { presencial: null, hibrido: "híbrido", remoto: "remoto" };

/** El nombre de cada portal, como se muestra. Get on Board pide aparecer como fuente de sus avisos. */
export const PORTALS: Record<string, string> = {
  computrabajo: "Computrabajo", laborum: "Laborum", bumeran: "Bumeran", multitrabajos: "Multitrabajos",
  konzerta: "Konzerta", trabajando: "Trabajando", getonboard: "Get on Board", bne: "la Bolsa Nacional de Empleo",
  magneto: "Magneto", chiletrabajos: "Chiletrabajos",
};

/**
 * El sueldo como se le muestra a la persona, en el mensaje y en las herramientas del agente. Un sueldo que no es una
 * sola cifra en moneda local viene como primera línea de la descripción y manda: un rango (la BNE y Magneto, que dejan
 * el tope en `salary` para el filtro) o un sueldo en dólares (Get on Board).
 */
export function salaryLine(j: Pick<Job, "salary" | "description">): string | null {
  const line = /^Sueldo(?: bruto)?: [^\n]+/.exec(j.description ?? "")?.[0];
  return line ?? (j.salary ? `Sueldo: ${money(j.salary)}` : null);
}

export function formatJob(j: Job, link: string, n?: number, ago?: string | null): string {
  const place = [j.company, j.location, MODALITY_LABEL[j.modality ?? "presencial"]].filter(Boolean).join(" · ");
  const portal = PORTALS[j.source];
  const salary = salaryLine(j);
  return [
    `${n ? `${n}. ` : ""}*${j.title}*`,
    place,
    salary,
    ago || portal ? ["Publicado", ago, portal && `en ${portal}`].filter(Boolean).join(" ") : null,
    link,
  ]
    .filter(Boolean)
    .join("\n");
}

/** `more`: los avisos pendientes que no caben en este mensaje; se ofrecen para que los pida. */
export function formatMessage(jobs: Job[], phone: string, more = 0): string {
  const head = jobs.length === 1 ? "Encontré un aviso nuevo para ti:" : `Encontré ${jobs.length} avisos nuevos para ti:`;
  return [
    head,
    ...jobs.map((j, i) => formatJob(j, jobLink(phone, j), i + 1, publishedAgo(j.published_at, j.country))),
    more > 0 ? `Tengo ${more} ${more === 1 ? "aviso más" : "avisos más"} para ti: pídemelos cuando quieras.` : null,
    "¿Te sirve alguno? Respóndeme con el número, o dime cuál no y por qué, y afino la búsqueda.",
  ].filter(Boolean).join("\n\n");
}

export type SendResult = "sent" | "template" | "failed";

/** Manda un mensaje por la API de servidor de Vatio. `template` solo se usa si la ventana de 24 h está cerrada. */
export type Sender = (msg: {
  to: string;
  text: string;
  key: string;
  template?: { name: string; language: string; params: string[] };
}) => Promise<{ status: number; id?: number; mode?: string; code?: string; message?: string }>;

/** Si la persona ya respondió al mensaje que mandamos con ese id en Vatio. */
export type Replied = (messageId: number) => Promise<boolean>;

const vatioUrl = (path: string) => `${config.vatio.baseUrl}/api/server/v1/${config.vatio.workspace}${path}`;

// POST /messages manda nuestro texto tal cual (con los links exactos) o, con la ventana de 24 h cerrada, la plantilla.
// Vatio ya no acepta `brief` aquí; el agente ve el mensaje en la conversación y responde con ese contexto.
export const vatioSender: Sender = async ({ to, text, key, template }) => {
  const res = await fetch(vatioUrl("/messages"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.vatio.serverKey}`,
      "idempotency-key": key,
    },
    body: JSON.stringify({ to, text, ...(template ? { template } : {}) }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, id: body.id, mode: body.mode, code: body.error?.code, message: body.error?.message };
};

// Vatio marca `replied_at` en el mensaje cuando la persona contesta, sea lo que sea que escriba.
export const vatioReplied: Replied = async (id) => {
  const res = await fetch(vatioUrl(`/messages/${id}`), {
    headers: { authorization: `Bearer ${config.vatio.serverKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Vatio ${res.status} al leer el mensaje ${id}`);
  return Boolean(((await res.json()) as { replied_at?: string | null }).replied_at);
};

/**
 * Manda a cada persona sus avisos pendientes.
 * - Ventana abierta: van como texto y quedan `sent`.
 * - Ventana cerrada: va la plantilla; los avisos siguen `pending` hasta que la persona responde y el agente los
 *   entrega con `avisos_pendientes`.
 * Cuándo se le puede escribir lo decide `canMessageNow`; si depende de que haya respondido, se le pregunta a Vatio.
 */
export async function notifyAll(
  db: DatabaseSync,
  send: Sender,
  opts: { at?: Date; ignoreSchedule?: boolean; replied?: Replied } = {},
): Promise<Record<SendResult | "waiting", number> & { errors: string[] }> {
  const out = { sent: 0, template: 0, failed: 0, waiting: 0, errors: [] as string[] };
  const phones = db
    .prepare(
      `SELECT DISTINCT d.phone FROM deliveries d JOIN users u ON u.phone = d.phone
       WHERE d.status = 'pending' AND u.active = 1`,
    )
    .all() as Array<{ phone: string }>;
  for (const { phone } of phones) {
    const user = rowToUser(db.prepare("SELECT * FROM users WHERE phone = ?").get(phone) as any);
    const can = opts.ignoreSchedule || canMessageNow(user, opts.at);
    if (can === false || (can === "if_replied" && !(await repliedToLast(user, opts.replied ?? vatioReplied, out.errors)))) {
      out.waiting++;
      continue;
    }
    // Un aviso aprobado con un perfil anterior puede ya no calzar: se revisa contra el perfil de hoy.
    const stale = db.prepare("UPDATE deliveries SET status = 'rejected', reason = 'ya no calza con el perfil' WHERE phone = ? AND job_id = ?");
    const jobs = pendingJobs(db, phone, config.maxJobsPerMessage * 3)
      .filter((j) => passesFilters(user, j) || (stale.run(phone, j.id), false))
      .slice(0, config.maxJobsPerMessage);
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

/**
 * Si se le puede escribir ahora: entre las 8 y las 19 h de su país, y un mensaje automático al día. Otro el mismo día
 * solo si la conversación está tibia, porque respondió al anterior: entonces devuelve "if_replied" y quien llama le
 * pregunta a Vatio. Lo que no sale ahora queda pendiente para la próxima corrida, o para cuando la persona escriba y el
 * agente se lo entregue con `avisos_pendientes`.
 */
export function canMessageNow(user: Pick<User, "country" | "last_notified_at">, at = new Date()): boolean | "if_replied" {
  const { hour, date } = localNow(user.country, at);
  const [from, to] = config.sendHours;
  if (hour < from || hour >= to) return false;
  if (!user.last_notified_at) return true;
  return localNow(user.country, new Date(user.last_notified_at)).date === date ? "if_replied" : true;
}

/** Si respondió al último mensaje automático. Sin su id (uno de antes de guardarlo) o si Vatio falla, no. */
async function repliedToLast(user: User, replied: Replied, errors: string[]): Promise<boolean> {
  if (user.last_message_id === null) return false;
  try {
    return await replied(user.last_message_id);
  } catch (e) {
    errors.push((e as Error).message);
    return false;
  }
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
    `INSERT INTO deliveries (phone, job_id, status, token, created_at, sent_at) VALUES (?, ?, 'sent', ?, ?, ?)
     ON CONFLICT (phone, job_id) DO UPDATE SET status = 'sent', token = excluded.token, sent_at = excluded.sent_at`,
  );
  const t = now();
  for (const id of jobIds) stmt.run(phone, id, linkToken(phone, id), t, t);
}

async function sendTo(db: DatabaseSync, user: User, jobs: Job[], send: Sender): Promise<SendResult> {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE phone = ? AND status = 'pending'").get(user.phone) as { n: number }).n;
  const text = formatMessage(jobs, user.phone, total - jobs.length);
  const key = createHash("sha256").update(`${user.phone}|${jobs.map((j) => j.id).join(",")}`).digest("hex").slice(0, 32);

  const first = await send({ to: user.phone, text, key });
  if (first.status === 200 || first.status === 202) {
    markSent(db, user.phone, jobs.map((j) => j.id));
    db.prepare("UPDATE users SET last_notified_at = ?, last_message_id = ? WHERE phone = ?").run(now(), first.id ?? null, user.phone);
    return "sent";
  }
  if (first.code === "opted_out") {
    db.prepare("UPDATE users SET active = 0, updated_at = ? WHERE phone = ?").run(now(), user.phone);
    return "failed";
  }
  if (first.code !== "outside_window") throw new Error(`Vatio ${first.status} ${first.code ?? ""}: ${first.message ?? ""}`);

  const second = await send({
    to: user.phone,
    text,
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
  db.prepare("UPDATE users SET last_notified_at = ?, last_message_id = ? WHERE phone = ?").run(now(), second.id ?? null, user.phone);
  return "template";
}
