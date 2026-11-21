import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { config } from "./config.ts";
import { fromBlob, getUser, now, toBlob, type Job, type User } from "./db.ts";
import type { Embedder } from "./embed.ts";
import type { Judge } from "./llm.ts";
import { pastFeedback, rank, userText } from "./match.ts";
import { markSent, pendingJobs } from "./notify.ts";
import { REGION_KEYS, normalizePhone, regionKey, type Modality } from "./text.ts";

export class ToolError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const Phone = z.string().transform(normalizePhone).refine((p) => p.length >= 9, "teléfono inválido");
const Regions = z
  .array(z.string())
  .transform((list) => [...new Set(list.map((r) => regionKey(r)).filter((r): r is string => r !== null))]);
const Modalities = z.array(z.enum(["presencial", "hibrido", "remoto"]));

const Preferences = z.object({
  phone: Phone,
  nombre: z.string().trim().max(80).optional(),
  resumen: z.string().trim().min(3).max(1000).optional(),
  cargos: z.array(z.string().trim().min(1)).max(10).optional(),
  regiones: Regions.optional(),
  modalidades: Modalities.optional(),
  sueldo_minimo: z.number().int().nonnegative().nullable().optional(),
  excluir: z.array(z.string().trim().min(1)).max(20).optional(),
});

function present(j: Job) {
  return {
    id: j.id,
    cargo: j.title,
    empresa: j.company ?? "Confidencial",
    lugar: j.location,
    modalidad: j.modality,
    jornada: j.job_type,
    sueldo: j.salary,
    publicado: j.published_at,
    portal: j.source,
    url: j.url,
    extracto: j.description.slice(0, 280),
  };
}

function requireUser(db: DatabaseSync, phone: string): User {
  const user = getUser(db, phone);
  if (!user) throw new ToolError(404, "Esta persona todavía no ha dicho qué busca. Pregúntale y guarda sus preferencias primero.");
  return user;
}

function userVector(db: DatabaseSync, phone: string): Float32Array {
  const row = db.prepare("SELECT embedding FROM users WHERE phone = ?").get(phone) as { embedding: Uint8Array };
  return fromBlob(row.embedding);
}

export function createTools(db: DatabaseSync, embed: Embedder, judge: Judge | null = null) {
  /**
   * Busca, marca como enviados los resultados y los devuelve para que el agente los muestre.
   * Con `review`, el modelo descarta primero los que no calzan con el perfil; si el modelo
   * falla, se entregan los más parecidos sin revisar antes que dejar a la persona sin respuesta.
   */
  async function searchAndMark(user: User, vector: Float32Array, review: boolean): Promise<ReturnType<typeof present>[]> {
    const found = rank(db, user, vector, {
      limit: review && judge ? config.candidatesPerUser : config.maxJobsPerMessage,
      skipStatuses: review ? ["sent", "rejected"] : ["sent"],
    });
    let keep = found.slice(0, config.maxJobsPerMessage);
    if (review && judge && found.length) {
      try {
        const verdicts = await judge(user, pastFeedback(db, user.phone), found.map((f) => f.job));
        const reject = db.prepare(
          `INSERT OR IGNORE INTO deliveries (phone, job_id, score, reason, status, created_at) VALUES (?, ?, ?, ?, 'rejected', ?)`,
        );
        found.forEach((f, i) => {
          if (!verdicts[i]!.ok) reject.run(user.phone, f.job.id, f.score, verdicts[i]!.reason, now());
        });
        keep = found.filter((_, i) => verdicts[i]!.ok).slice(0, config.maxJobsPerMessage);
      } catch (e) {
        console.error("revisión del modelo falló en la búsqueda:", (e as Error).message);
      }
    }
    markSent(db, user.phone, keep.map((f) => f.job.id));
    return keep.map((f) => present(f.job));
  }

  return {
    /** Crea o actualiza el perfil. Los campos que no vienen se conservan. */
    async guardar_preferencias(input: unknown) {
      const p = Preferences.parse(input);
      const old = getUser(db, p.phone);
      const summary = p.resumen ?? old?.summary;
      if (!summary) throw new ToolError(422, "Falta `resumen`: qué trabajo busca la persona, en sus palabras.");
      const next = {
        name: p.nombre ?? old?.name ?? null,
        summary,
        roles: p.cargos ?? old?.roles ?? [],
        regions: p.regiones ?? old?.regions ?? [],
        modalities: (p.modalidades ?? old?.modalities ?? []) as Modality[],
        min_salary: p.sueldo_minimo !== undefined ? p.sueldo_minimo : (old?.min_salary ?? null),
        exclude: p.excluir ?? old?.exclude ?? [],
      };
      const [vector] = await embed([userText(next)], "query");
      const t = now();
      db.prepare(
        `INSERT INTO users (phone, name, summary, roles, regions, modalities, min_salary, exclude, embedding,
                            active, matched_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT (phone) DO UPDATE SET
           name = excluded.name, summary = excluded.summary, roles = excluded.roles, regions = excluded.regions,
           modalities = excluded.modalities, min_salary = excluded.min_salary, exclude = excluded.exclude,
           embedding = excluded.embedding, active = 1, updated_at = excluded.updated_at`,
      ).run(
        p.phone, next.name, next.summary, JSON.stringify(next.roles), JSON.stringify(next.regions),
        JSON.stringify(next.modalities), next.min_salary, JSON.stringify(next.exclude), toBlob(vector!), t, t, t,
      );
      const user = getUser(db, p.phone)!;
      return {
        guardado: true,
        nuevo: !old,
        preferencias: {
          resumen: user.summary, cargos: user.roles, regiones: user.regions,
          modalidades: user.modalities, sueldo_minimo: user.min_salary, excluir: user.exclude,
        },
        avisos: await searchAndMark(user, vector!, true),
      };
    },

    /** Búsqueda a pedido entre los avisos guardados; `consulta` y `region` son opcionales. */
    async buscar_avisos(input: unknown) {
      const p = z
        .object({ phone: Phone, consulta: z.string().trim().max(300).optional(), region: z.string().optional() })
        .parse(input);
      const user = requireUser(db, p.phone);
      const region = p.region ? regionKey(p.region) : null;
      if (p.region && !region) throw new ToolError(422, `No reconozco la región "${p.region}". Opciones: ${REGION_KEYS.join(", ")}.`);
      const vector = p.consulta ? (await embed([p.consulta], "query"))[0]! : userVector(db, p.phone);
      const scoped = region ? { ...user, regions: [region] } : user;
      // Una consulta propia puede salirse del perfil a propósito, así que no se revisa contra él.
      return { avisos: await searchAndMark(scoped, vector, !p.consulta) };
    },

    /** Los avisos que el match dejó listos y todavía no se le mostraron. */
    async avisos_pendientes(input: unknown) {
      const p = z.object({ phone: Phone }).parse(input);
      requireUser(db, p.phone);
      const jobs = pendingJobs(db, p.phone, config.maxJobsPerMessage);
      markSent(db, p.phone, jobs.map((j) => j.id));
      return { avisos: jobs.map(present) };
    },

    async registrar_opinion(input: unknown) {
      const p = z
        .object({ phone: Phone, aviso_id: z.string(), util: z.boolean(), motivo: z.string().trim().max(300).optional() })
        .parse(input);
      const res = db
        .prepare("UPDATE deliveries SET useful = ?, feedback = ? WHERE phone = ? AND job_id = ?")
        .run(p.util ? 1 : 0, p.motivo ?? null, p.phone, p.aviso_id);
      if (res.changes === 0) throw new ToolError(404, `No le hemos mandado el aviso ${p.aviso_id} a esta persona.`);
      return { registrado: true };
    },

    /** Pausa o reanuda los avisos automáticos. */
    async pausar_avisos(input: unknown) {
      const p = z.object({ phone: Phone, pausar: z.boolean() }).parse(input);
      requireUser(db, p.phone);
      // Al reanudar no se mandan de golpe los avisos acumulados durante la pausa.
      db.prepare("UPDATE users SET active = ?, matched_until = ?, updated_at = ? WHERE phone = ?").run(
        p.pausar ? 0 : 1, now(), now(), p.phone,
      );
      return { activo: !p.pausar };
    },

    /** Borra todo lo que guardamos de la persona. */
    async borrar_mis_datos(input: unknown) {
      const p = z.object({ phone: Phone }).parse(input);
      db.prepare("DELETE FROM deliveries WHERE phone = ?").run(p.phone);
      const res = db.prepare("DELETE FROM users WHERE phone = ?").run(p.phone);
      return { borrado: res.changes > 0 };
    },
  };
}

export type Tools = ReturnType<typeof createTools>;
