import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { now, toBlob } from "./db.ts";
import type { Embedder } from "./embed.ts";
import type { NewJob, Source } from "./sources/types.ts";
import { normalize } from "./text.ts";

export function jobText(j: Pick<NewJob, "title" | "company" | "location" | "description">): string {
  return [j.title, j.company, j.location, j.description.slice(0, 1200)].filter(Boolean).join(". ");
}

// Formas societarias que cada portal escribe distinto ("ACTIVOS S A S", "Activos S.A.S.").
const LEGAL = /\b(s a s|sas|s a c|sac|s a de c v|s de r l de c v|s r l|srl|s a|sa|spa|ltda|limitada|eirl|e i r l|cia|inc|corp)\b/g;

/**
 * La huella de un aviso: el mismo cargo, de la misma empresa, en la misma región del mismo país. Dos avisos
 * con la misma huella son el mismo si además coinciden en localidad (sameLocality): así la misma vacante en
 * dos portales, o republicada, cuenta una vez, pero la de dos tiendas en comunas distintas cuenta dos.
 * Si la empresa es confidencial no hay con qué
 * distinguir dos avisos de igual título, así que se usa el comienzo de la descripción.
 */
export function dedupeKey(j: Pick<NewJob, "country" | "title" | "company" | "region" | "description">): string {
  const company = companyKey(j.company);
  const who = company || `?${normalize(j.description).slice(0, 120)}`;
  return [j.country, normalize(j.title), who, j.region ?? ""].join("|");
}

/** La empresa sin forma societaria; vacía si el aviso no la dice o la deja confidencial. */
export function companyKey(company: string | null | undefined): string {
  const c = normalize(company ?? "").replace(LEGAL, " ").replace(/\s+/g, " ").trim();
  return /^(empresa )?(confidencial|reservad[ao])$/.test(c) ? "" : c;
}

/** Qué parte de las palabras de dos descripciones comparten (las de más de 3 letras). */
export function sharedWords(a: string, b: string): number {
  const words = (s: string) => new Set(normalize(s).split(" ").filter((w) => w.length > 3));
  const x = words(a);
  const y = words(b);
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both || 1);
}

/**
 * El mismo aviso en un portal que dice la empresa y en otro que no la dice tiene distinta huella. Se reconoce por
 * el mismo cargo en la misma región y la descripción en buena parte igual, sin mirar la localidad, que un portal
 * da por comuna ("Las Condes") y otro por ciudad ("Santiago"). En avisos reales de Chile, los pares así que eran el
 * mismo aviso compartían el 70 % de las palabras, y el que no lo era, el 7 %. El parecido de los embeddings no
 * sirve: dos avisos de una empresa que solo cambian la jornada o el local pasan de 0,98.
 */
export const SAME_AD_WORDS = 0.5;

const PLACE_NOISE = new Set(["region", "provincia", "departamento", "estado", "de", "del", "la", "las", "los", "el", "y", "r", "d", "c", "df", "dc"]);

/**
 * Las palabras del lugar que no son la región: la comuna, distrito o ciudad. Cada portal ordena y escribe
 * el lugar a su manera ("Maipú, Región Metropolitana", "R.Metropolitana, Santiago - Maipú"), así que se
 * comparan como conjunto de palabras y no como texto.
 */
export function localityOf(j: Pick<NewJob, "location" | "region">): string[] {
  const region = new Set(normalize(j.region ?? "").split(" "));
  return [...new Set(normalize(j.location ?? "").split(" "))].filter((w) => w && !region.has(w) && !PLACE_NOISE.has(w)).sort();
}

/** Misma huella y además el mismo lugar: una localidad en común, o alguno de los dos no la informa. */
export function sameLocality(a: string[], b: string[]): boolean {
  return a.length === 0 || b.length === 0 || a.some((w) => b.includes(w));
}

// Portales de un solo sitio: cada uno es su propio operador.
const SINGLE_SITE = new Set(["trabajando", "bne", "magneto", "chiletrabajos"]);

/** "computrabajo-mx" -> "computrabajo"; los sitios Jobint (laborum, bumeran-*, multitrabajos, konzerta) comparten operador. */
export function operatorOf(sourceKey: string): string {
  if (sourceKey.startsWith("computrabajo")) return "computrabajo";
  if (SINGLE_SITE.has(sourceKey)) return sourceKey;
  if (sourceKey.startsWith("getonboard")) return "getonboard";
  return "jobint";
}

export type IngestReport = Record<
  string,
  { added: number; duplicates: number; pages: number; invalid: number; closed?: number; note?: string; error?: string }
>;

/** Trae los avisos nuevos de cada portal y los guarda con su embedding. Un portal caído no detiene al otro. */
export async function ingest(
  db: DatabaseSync,
  embed: Embedder,
  sources: Record<string, { source: Source; maxPages: number }>,
): Promise<IngestReport> {
  const known = db.prepare("SELECT 1 FROM jobs WHERE id = ?");
  const insert = db.prepare(
    `INSERT OR IGNORE INTO jobs
      (id, source, source_id, country, url, title, company, location, region, modality, job_type, salary,
       description, published_at, first_seen_at, embedding, dedupe_key, locality, duplicate_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const originals = db.prepare("SELECT id, locality FROM jobs WHERE dedupe_key = ? AND duplicate_of IS NULL");
  const sameTitle = db.prepare(
    "SELECT id, company, description, dedupe_key FROM jobs WHERE dedupe_key >= ? AND dedupe_key < ? AND duplicate_of IS NULL",
  );
  const findOriginal = (key: string, locality: string[], job: NewJob): string | null => {
    const rows = originals.all(key) as Array<{ id: string; locality: string | null }>;
    const exact = rows.find((r) => sameLocality(locality, r.locality ? r.locality.split(" ") : []))?.id;
    if (exact) return exact;
    // El mismo aviso con la empresa en un portal y sin ella en otro (ver SAME_AD_WORDS).
    const [country, title] = key.split("|");
    const prefix = `${country}|${title}|`;
    const hidden = !companyKey(job.company);
    const candidates = sameTitle.all(prefix, `${prefix}\uffff`) as Array<{ id: string; company: string | null; description: string; dedupe_key: string }>;
    return candidates.find((r) =>
      r.dedupe_key.split("|").at(-1) === (job.region ?? "") &&
      !companyKey(r.company) !== hidden &&
      sharedWords(r.description, job.description) >= SAME_AD_WORDS,
    )?.id ?? null;
  };
  const report: IngestReport = {};
  // Los portales de un mismo operador van uno tras otro, para no sumarle carga; operadores distintos, en paralelo.
  const lanes = new Map<string, Array<[string, { source: Source; maxPages: number }]>>();
  for (const entry of Object.entries(sources)) {
    const lane = operatorOf(entry[0]);
    lanes.set(lane, [...(lanes.get(lane) ?? []), entry]);
  }
  await Promise.all([...lanes.values()].map(async (lane) => {
   for (const [name, { source, maxPages }] of lane) {
    try {
      const res = await source({ maxPages, isKnown: (id) => known.get(id) !== undefined });
      // Los duplicados se guardan (para no volver a pedirlos al portal) pero sin embedding: nunca se ofrecen.
      // Se decide aquí, sin esperas de por medio, para que dos portales en paralelo no guarden el mismo aviso.
      const keyed = res.jobs.map((j) => ({ job: j, key: dedupeKey(j), locality: localityOf(j) }));
      const inBatch = new Map<string, Array<{ id: string; locality: string[] }>>();
      const dupOf = keyed.map(({ job, key, locality }) => {
        const prior =
          findOriginal(key, locality, job) ?? inBatch.get(key)?.find((o) => sameLocality(locality, o.locality))?.id ?? null;
        if (!prior) inBatch.set(key, [...(inBatch.get(key) ?? []), { id: job.id, locality }]);
        return prior;
      });
      const fresh = keyed.filter((_, i) => !dupOf[i]);
      const vectors = await embed(fresh.map((k) => jobText(k.job)), "passage");
      const seenAt = now();
      let v = 0;
      let duplicates = 0;
      keyed.forEach(({ job: j, key, locality }, i) => {
        // Se vuelve a mirar: mientras se calculaban los embeddings, otro portal pudo guardar el original.
        const prior = dupOf[i] ?? findOriginal(key, locality, j);
        const vector = dupOf[i] ? null : vectors[v++]!;
        if (prior) duplicates++;
        insert.run(
          j.id, j.source, j.source_id, j.country, j.url, j.title, j.company, j.location, j.region, j.modality,
          j.job_type, j.salary, j.description, j.published_at, seenAt, prior ? null : toBlob(vector!), key, locality.join(" "), prior,
        );
      });
      // Con el listado entero de la fuente, lo suyo que ya no aparece se dejó de publicar: sin embedding no se
      // ofrece más (como un duplicado), y lo pendiente de enviar se descarta.
      let closed = 0;
      if (res.listed) {
        const live = new Set(res.listed);
        const ours = db.prepare("SELECT id FROM jobs WHERE id LIKE ? AND embedding IS NOT NULL").all(`${name}:%`) as Array<{ id: string }>;
        for (const { id } of ours.filter((r) => !live.has(r.id))) {
          db.prepare("UPDATE jobs SET embedding = NULL WHERE id = ?").run(id);
          db.prepare("DELETE FROM deliveries WHERE job_id = ? AND status = 'pending'").run(id);
          closed++;
        }
      }
      report[name] = {
        added: res.jobs.length - duplicates, duplicates, pages: res.pages, invalid: res.invalid,
        ...(closed ? { closed } : {}), ...(res.note ? { note: res.note } : {}),
      };
    } catch (e) {
      report[name] = { added: 0, duplicates: 0, pages: 0, invalid: 0, error: (e as Error).message };
    }
   }
  }));
  const cutoff = new Date(Date.now() - config.jobRetentionDays * 86_400_000).toISOString();
  db.prepare("DELETE FROM deliveries WHERE job_id IN (SELECT id FROM jobs WHERE first_seen_at < ?)").run(cutoff);
  db.prepare("DELETE FROM jobs WHERE first_seen_at < ?").run(cutoff);
  return report;
}
