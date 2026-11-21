import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { now, toBlob } from "./db.ts";
import type { Embedder } from "./embed.ts";
import type { NewJob, Source } from "./sources/types.ts";

export function jobText(j: Pick<NewJob, "title" | "company" | "location" | "description">): string {
  return [j.title, j.company, j.location, j.description.slice(0, 1200)].filter(Boolean).join(". ");
}

/** "computrabajo-mx" -> "computrabajo"; los sitios Jobint (laborum, bumeran-*, multitrabajos, konzerta) comparten operador. */
export function operatorOf(sourceKey: string): string {
  if (sourceKey.startsWith("computrabajo")) return "computrabajo";
  if (sourceKey === "trabajando") return "trabajando";
  return "jobint";
}

export type IngestReport = Record<string, { added: number; pages: number; invalid: number; error?: string }>;

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
       description, published_at, first_seen_at, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
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
      const vectors = await embed(res.jobs.map(jobText), "passage");
      const seenAt = now();
      res.jobs.forEach((j, i) => {
        insert.run(
          j.id, j.source, j.source_id, j.country, j.url, j.title, j.company, j.location, j.region, j.modality,
          j.job_type, j.salary, j.description, j.published_at, seenAt, toBlob(vectors[i]!),
        );
      });
      report[name] = { added: res.jobs.length, pages: res.pages, invalid: res.invalid };
    } catch (e) {
      report[name] = { added: 0, pages: 0, invalid: 0, error: (e as Error).message };
    }
   }
  }));
  const cutoff = new Date(Date.now() - config.jobRetentionDays * 86_400_000).toISOString();
  db.prepare("DELETE FROM deliveries WHERE job_id IN (SELECT id FROM jobs WHERE first_seen_at < ?)").run(cutoff);
  db.prepare("DELETE FROM jobs WHERE first_seen_at < ?").run(cutoff);
  return report;
}
