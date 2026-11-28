import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { config } from "./config.ts";
import { getUser, now, toBlob, toBlobs, type Job, type User } from "./db.ts";
import type { Embedder } from "./embed.ts";
import type { Judge } from "./llm.ts";
import { pastFeedback, queriesOf, rank, userText } from "./match.ts";
import { jobLink } from "./feedback.ts";
import { PORTALS, markSent, pendingJobs, salaryLine } from "./notify.ts";
import { COUNTRIES, ENABLED_COUNTRIES, JOB_KINDS, publishedAgo, countryOf, countryOfPhone, normalize, normalizePhone, regionOf, type Country, type JobKind, type Modality, type ModalityRegions } from "./text.ts";

const SUPPORTED = `Países disponibles: ${ENABLED_COUNTRIES.map((c) => COUNTRIES[c]).join(", ")}.`;

export class ToolError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const Phone = z.string().transform(normalizePhone).refine((p) => p.length >= 9, "teléfono inválido");
const Modalities = z.array(z.enum(["presencial", "hibrido", "remoto"]));

const Preferences = z.object({
  phone: Phone,
  pais: z.string().optional(),
  nombre: z.string().trim().max(80).optional(),
  resumen: z.string().trim().min(3).max(1000).optional(),
  estudios: z.string().trim().max(200).optional(),
  primer_trabajo: z.boolean().optional(),
  tipos: z.array(z.enum(JOB_KINDS)).optional(),
  cargos: z.array(z.string().trim().min(1)).max(10).optional(),
  regiones: z.array(z.string().trim().min(1)).max(10).optional(),
  modalidades: Modalities.optional(),
  solo_en: z
    .object({ presencial: z.array(z.string().trim().min(1)).max(10).optional(), hibrido: z.array(z.string().trim().min(1)).max(10).optional() })
    .optional(),
  sueldo_minimo: z.number().int().nonnegative().nullable().optional(),
  excluir: z.array(z.string().trim().min(1)).max(20).optional(),
});

function present(j: Job, phone: string) {
  return {
    id: j.id,
    cargo: j.title,
    empresa: j.company ?? "Confidencial",
    lugar: j.location,
    modalidad: j.modality,
    jornada: j.job_type,
    // Como texto, tal como se muestra: un rango o un sueldo en dólares no caben en una cifra.
    sueldo: salaryLine(j),
    publicado: j.published_at,
    publicado_hace: publishedAgo(j.published_at, j.country),
    portal: PORTALS[j.source] ?? j.source,
    url: jobLink(phone, j),
    extracto: j.description.slice(0, 280),
  };
}

function requireUser(db: DatabaseSync, phone: string): User {
  const user = getUser(db, phone);
  if (!user) throw new ToolError(404, "Esta persona todavía no ha dicho qué busca. Pregúntale y guarda sus preferencias primero.");
  return user;
}

function userQueries(db: DatabaseSync, phone: string): Float32Array[] {
  return queriesOf(db.prepare("SELECT embedding, role_embeddings FROM users WHERE phone = ?").get(phone) as { embedding: Uint8Array; role_embeddings: Uint8Array | null });
}

/** `profileSaved` corre después de guardar un perfil, con el anterior (null si es nuevo); no debe demorar la respuesta. */
export type ToolHooks = { profileSaved?: (old: User | null, user: User) => void };

/** El perfil con los nombres de campo de `guardar_preferencias`, como lo ven el agente y la consola. */
export function preferencesOf(user: User) {
  return {
    pais: COUNTRIES[user.country], nombre: user.name, resumen: user.summary, estudios: user.studies,
    primer_trabajo: user.first_job, tipos: user.job_kinds, cargos: user.roles, regiones: user.regions,
    modalidades: user.modalities, solo_en: user.modality_regions, sueldo_minimo: user.min_salary, excluir: user.exclude,
  };
}

/**
 * Crea o actualiza el perfil; los campos que no vienen se conservan. No busca avisos ni marca ninguno como enviado:
 * eso lo hace `guardar_preferencias`. La consola lo usa para corregir un perfil sin mostrarle nada a la persona.
 */
export function createProfileSaver(db: DatabaseSync, embed: Embedder, hooks: ToolHooks = {}) {
  return async function saveProfile(input: unknown): Promise<{ user: User; queries: Float32Array[]; isNew: boolean }> {
    const p = Preferences.parse(input);
    const old = getUser(db, p.phone);
    // El país sale del código del número; `pais` lo cambia si la persona busca en otro.
    const asked = p.pais ? countryOf(p.pais) : null;
    if (p.pais && !asked) throw new ToolError(422, `Todavía no tenemos avisos de "${p.pais}". ${SUPPORTED}`);
    const country: Country | null = asked ?? old?.country ?? countryOfPhone(p.phone);
    if (!country) throw new ToolError(422, `Todavía no tenemos avisos del país de este número. ${SUPPORTED} Si busca en uno de esos, manda \`pais\`.`);
    const regions = (list: string[]) => [...new Set(list.map((r) => regionOf(country, r)).filter((r): r is string => r !== null))];
    const summary = p.resumen ?? old?.summary;
    if (!summary) throw new ToolError(422, "Falta `resumen`: qué trabajo busca la persona, en sus palabras.");
    const next = {
      name: p.nombre ?? old?.name ?? null,
      summary,
      studies: p.estudios ?? old?.studies ?? null,
      first_job: p.primer_trabajo ?? old?.first_job ?? null,
      job_kinds: (p.tipos ?? old?.job_kinds ?? []) as JobKind[],
      roles: p.cargos ?? old?.roles ?? [],
      // Si cambió de país, las regiones anteriores ya no aplican.
      regions: p.regiones ? regions(p.regiones) : old && old.country === country ? old.regions : [],
      modalities: (p.modalidades ?? old?.modalities ?? []) as Modality[],
      // Una lista vacía quita la restricción de esa modalidad; si no viene, se conserva.
      modality_regions: p.solo_en
        ? (Object.fromEntries(
            Object.entries(p.solo_en)
              .map(([m, list]) => [m, regions(list ?? [])] as const)
              .filter(([, list]) => list.length),
          ) as ModalityRegions)
        : old && old.country === country ? old.modality_regions : {},
      min_salary: p.sueldo_minimo !== undefined ? p.sueldo_minimo : (old?.min_salary ?? null),
      exclude: p.excluir ?? old?.exclude ?? [],
    };
    // Una región de `solo_en` también es de las suyas: si no, el filtro de región la descartaría antes.
    next.regions = [...new Set([...next.regions, ...Object.values(next.modality_regions).flat()])];
    // El perfil entero y cada cargo por separado: `rank` busca con los cargos, o con el perfil si no hay (ver queriesOf).
    const [vector, ...roleVectors] = await embed([userText(next), ...next.roles], "query");
    const t = now();
    db.prepare(
      `INSERT INTO users (phone, country, name, summary, studies, first_job, job_kinds, roles, regions, modalities, modality_regions, min_salary,
                          exclude, embedding, role_embeddings, active, matched_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT (phone) DO UPDATE SET
         country = excluded.country, name = excluded.name, summary = excluded.summary, studies = excluded.studies,
         first_job = excluded.first_job, job_kinds = excluded.job_kinds, roles = excluded.roles, regions = excluded.regions,
         modalities = excluded.modalities, modality_regions = excluded.modality_regions, min_salary = excluded.min_salary, exclude = excluded.exclude,
         embedding = excluded.embedding, role_embeddings = excluded.role_embeddings, active = 1, updated_at = excluded.updated_at`,
    ).run(
      p.phone, country, next.name, next.summary, next.studies,
      next.first_job === null ? null : next.first_job ? 1 : 0, JSON.stringify(next.job_kinds), JSON.stringify(next.roles), JSON.stringify(next.regions),
      JSON.stringify(next.modalities), JSON.stringify(next.modality_regions), next.min_salary, JSON.stringify(next.exclude), toBlob(vector!), toBlobs(roleVectors), t, t, t,
    );
    // Lo evaluado con el perfil anterior ya no vale: se olvida, y la próxima corrida vuelve a mirar los avisos
    // de los últimos 3 días con el perfil nuevo.
    if (old) {
      db.prepare("DELETE FROM deliveries WHERE phone = ? AND status IN ('pending', 'rejected')").run(p.phone);
      db.prepare("UPDATE users SET matched_until = ? WHERE phone = ?").run(new Date(Date.now() - 3 * 86_400_000).toISOString(), p.phone);
    }
    const user = getUser(db, p.phone)!;
    hooks.profileSaved?.(old, user);
    return { user, queries: roleVectors.length ? roleVectors : [vector!], isNew: !old };
  };
}

export function createTools(db: DatabaseSync, embed: Embedder, judge: Judge | null = null, hooks: ToolHooks = {}) {
  const saveProfile = createProfileSaver(db, embed, hooks);

  /**
   * La búsqueda con el perfil: marca como enviados los resultados y los devuelve para que el agente los muestre.
   * El modelo descarta primero los que no calzan con el perfil. Si falla, se entregan los más parecidos sin revisar
   * antes que dejar a la persona sin respuesta.
   */
  async function searchAndMark(user: User, queries: Float32Array[]): Promise<ReturnType<typeof present>[]> {
    db.prepare("UPDATE users SET searched_at = ? WHERE phone = ?").run(now(), user.phone);
    const found = rank(db, user, queries, {
      limit: judge ? config.candidatesPerUser : config.maxJobsPerMessage,
      skipStatuses: ["sent", "rejected"],
    });
    // Cada aviso que sale guarda por qué: el motivo del modelo, o que salió sin revisión. Sin eso no se puede saber
    // después si un aviso que no calzaba lo aprobó el modelo o lo dejó pasar el respaldo.
    let keep = found.slice(0, config.maxJobsPerMessage).map((f) => ({ ...f, reason: judge ? "sin revisión: el modelo falló" : "sin revisión: no hay modelo" }));
    if (judge && found.length) {
      try {
        const verdicts = await judge(user, pastFeedback(db, user.phone), found.map((f) => f.job));
        const reject = db.prepare(
          `INSERT OR IGNORE INTO deliveries (phone, job_id, score, reason, status, created_at) VALUES (?, ?, ?, ?, 'rejected', ?)`,
        );
        found.forEach((f, i) => {
          if (!verdicts[i]!.ok) reject.run(user.phone, f.job.id, f.score, verdicts[i]!.reason, now());
        });
        keep = found
          .map((f, i) => ({ ...f, reason: verdicts[i]!.reason }))
          .filter((_, i) => verdicts[i]!.ok)
          .slice(0, config.maxJobsPerMessage);
      } catch (e) {
        console.error("revisión del modelo falló en la búsqueda:", (e as Error).message);
      }
    }
    markSent(db, user.phone, keep.map((f) => f.job.id));
    const why = db.prepare("UPDATE deliveries SET score = ?, reason = ? WHERE phone = ? AND job_id = ?");
    for (const f of keep) why.run(f.score, f.reason, user.phone, f.job.id);
    return keep.map((f) => present(f.job, user.phone));
  }

  /**
   * El aviso al que se refiere la persona. El agente puede mandar el id interno ("laborum:123") o, como el mensaje
   * automático solo muestra links, el código del link ("sjrr3muj6z") o el link entero. Solo vale un aviso que se le mandó.
   */
  function resolveJobId(phone: string, ref: string): string | null {
    const sent = db.prepare("SELECT job_id FROM deliveries WHERE phone = ? AND job_id = ? AND status = 'sent'");
    if (sent.get(phone, ref)) return ref;
    const token = ref.trim().replace(/\/+$/, "").split("/").pop()!.toLowerCase();
    if (token.length >= 6) {
      const rows = db
        .prepare("SELECT job_id FROM deliveries WHERE phone = ? AND status = 'sent' AND token LIKE ? LIMIT 2")
        .all(phone, `${token}%`) as Array<{ job_id: string }>;
      if (rows.length === 1) return rows[0]!.job_id;
    }
    // A veces el agente manda algo del título ("ID 1420 SERPAJ…" llegó como "1420"): vale si calza con uno solo.
    const words = normalize(ref);
    if (words.length < 3) return null;
    const titles = db
      .prepare("SELECT d.job_id, j.title FROM deliveries d JOIN jobs j ON j.id = d.job_id WHERE d.phone = ? AND d.status = 'sent'")
      .all(phone) as Array<{ job_id: string; title: string }>;
    const hits = titles.filter((s) => ` ${normalize(s.title)} `.includes(` ${words} `));
    return hits.length === 1 ? hits[0]!.job_id : null;
  }

  return {
    /** Crea o actualiza el perfil y devuelve los avisos que ya le sirven. Los campos que no vienen se conservan. */
    async guardar_preferencias(input: unknown) {
      const { user, queries, isNew } = await saveProfile(input);
      return { guardado: true, nuevo: isNew, preferencias: preferencesOf(user), avisos: await searchAndMark(user, queries) };
    },

    /** Lo que tenemos guardado de la persona, para mostrárselo. */
    async ver_perfil(input: unknown) {
      const p = z.object({ phone: Phone }).parse(input);
      const user = requireUser(db, p.phone);
      const count = (status: string) =>
        (db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE phone = ? AND status = ?").get(p.phone, status) as { n: number }).n;
      return {
        preferencias: preferencesOf(user),
        avisos_automaticos: user.active ? "activos" : "en pausa",
        avisos_enviados: count("sent"),
      };
    },

    /**
     * La misma búsqueda que corre al guardar el perfil, a pedido. No hay búsquedas con otra consulta ni otra región:
     * a una psicóloga que buscó "psicóloga clínica" le llegaban técnicos en enfermería por la palabra "clínica". Para
     * buscar otra cosa, se cambia el perfil. Si desde la última búsqueda no llegó ningún aviso que pase sus filtros ni
     * hay pendientes, no se repite: `sin_novedades` le dice al agente que se lo cuente así.
     */
    async buscar_avisos(input: unknown) {
      const p = z.object({ phone: Phone }).parse(input);
      const user = requireUser(db, p.phone);
      const queries = userQueries(db, p.phone);
      const hasPending = db.prepare("SELECT 1 FROM deliveries WHERE phone = ? AND status = 'pending' LIMIT 1").get(p.phone);
      const fresh =
        !user.searched_at ||
        hasPending ||
        rank(db, user, queries, { since: user.searched_at, limit: 1, skipStatuses: ["sent", "rejected"] }).length > 0;
      if (!fresh) return { avisos: [], sin_novedades: true };
      return { avisos: await searchAndMark(user, queries), sin_novedades: false };
    },

    /** Los avisos que el match dejó listos y todavía no se le mostraron. */
    async avisos_pendientes(input: unknown) {
      const p = z.object({ phone: Phone }).parse(input);
      requireUser(db, p.phone);
      const jobs = pendingJobs(db, p.phone, config.maxJobsPerMessage);
      markSent(db, p.phone, jobs.map((j) => j.id));
      return { avisos: jobs.map((j) => present(j, p.phone)) };
    },

    async registrar_opinion(input: unknown) {
      const p = z
        .object({
          phone: Phone,
          aviso_id: z.string(),
          // Vatio no manda los `false` en el body, y no llama a la herramienta si falta un parámetro requerido:
          // si `util` no viene, el agente dijo false.
          util: z.boolean().default(false),
          postulo: z.boolean().optional(),
          motivo: z.string().trim().max(300).optional(),
        })
        .parse(input);
      const jobId = resolveJobId(p.phone, p.aviso_id);
      if (!jobId) throw new ToolError(404, `No le hemos mandado el aviso ${p.aviso_id} a esta persona.`);
      // Postular implica que le sirvió. Un dato que no viene no borra el que ya estaba.
      db.prepare(
        `UPDATE deliveries SET useful = ?, applied = COALESCE(?, applied), feedback = COALESCE(?, feedback)
         WHERE phone = ? AND job_id = ?`,
      ).run(p.util || p.postulo ? 1 : 0, p.postulo === undefined ? null : p.postulo ? 1 : 0, p.motivo ?? null, p.phone, jobId);
      return { registrado: true };
    },

    /** Pausa o reanuda los avisos automáticos. */
    async pausar_avisos(input: unknown) {
      // Como en registrar_opinion: Vatio no manda `pausar: false`, así que si no viene es reanudar.
      const p = z.object({ phone: Phone, pausar: z.boolean().default(false) }).parse(input);
      const old = requireUser(db, p.phone);
      // Al reanudar no se mandan de golpe los avisos acumulados durante la pausa.
      db.prepare("UPDATE users SET active = ?, matched_until = ?, updated_at = ? WHERE phone = ?").run(
        p.pausar ? 0 : 1, now(), now(), p.phone,
      );
      if (!p.pausar) hooks.profileSaved?.(old, getUser(db, p.phone)!);
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
