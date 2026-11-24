import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { now, type User } from "./db.ts";
import type { Embedder } from "./embed.ts";
import { ingest, type IngestReport } from "./ingest.ts";
import { llmJudge } from "./llm.ts";
import { matchAll } from "./match.ts";
import { notifyAll, vatioSender } from "./notify.ts";
import { COMPUTRABAJO_SITES, computrabajo, regionsFor, type Region } from "./sources/computrabajo.ts";
import { jobint } from "./sources/jobint.ts";
import type { Source } from "./sources/types.ts";
import { JOBINT_SITES } from "./sources/jobint.ts";
import { trabajando } from "./sources/trabajando.ts";
import { isEnabled } from "./text.ts";

/**
 * Fuentes que respondieron 403 o 429 en su último intento y todavía están en su tiempo de descanso. No se insiste:
 * se vuelve a probar una vez pasado BLOCKED_SOURCE_BACKOFF_HOURS, con el mismo ritmo de siempre.
 */
export function restingSources(db: DatabaseSync, at = Date.now()): Map<string, string> {
  const runs = db.prepare("SELECT started_at, result FROM ingest_runs WHERE result IS NOT NULL ORDER BY id DESC LIMIT 200").all() as Array<{ started_at: string; result: string }>;
  const lastTry = new Map<string, { at: number; error?: string }>();
  for (const run of runs) {
    const ingested = (JSON.parse(run.result).ingested ?? {}) as Record<string, { error?: string; skipped?: string }>;
    for (const [key, r] of Object.entries(ingested)) {
      if (r.skipped || lastTry.has(key)) continue;
      lastTry.set(key, { at: Date.parse(run.started_at), error: r.error });
    }
  }
  const out = new Map<string, string>();
  for (const [key, t] of lastTry) {
    if (!t.error || !/respondió (403|429)\b/.test(t.error)) continue;
    const until = t.at + config.blockedSourceBackoffHours * 3_600_000;
    if (at < until) out.set(key, new Date(until).toISOString());
  }
  return out;
}

/** Las regiones guardadas de las personas activas de un país, menos `except`. */
function activeUsers(db: DatabaseSync, country: string, except?: string): Array<Pick<User, "regions">> {
  const rows = db.prepare("SELECT regions FROM users WHERE active = 1 AND country = ? AND phone IS NOT ?").all(country, except ?? null);
  return (rows as Array<{ regions: string }>).map((r) => ({ regions: JSON.parse(r.regions) as string[] }));
}

/** El sitio de Computrabajo de un país, si está habilitado. */
function computrabajoSite(country: string): string | null {
  const key = `computrabajo-${country.toLowerCase()}`;
  const enabled = config.computrabajoSites ?? Object.keys(COMPUTRABAJO_SITES);
  return enabled.includes(key) && COMPUTRABAJO_SITES[key] && isEnabled(COMPUTRABAJO_SITES[key].country) ? key : null;
}

export function sources(db: DatabaseSync): Record<string, { source: Source; maxPages: number }> {
  const all: Record<string, { source: Source; maxPages: number }> = {};
  // Solo se traen avisos de los países abiertos.
  for (const key of config.jobintSites) {
    if (isEnabled(JOBINT_SITES[key]!.country)) all[key] = { source: jobint(key), maxPages: config.jobintMaxPages };
  }
  // Computrabajo se recorre región por región, así que solo se piden las regiones de las personas activas.
  for (const key of config.computrabajoSites ?? Object.keys(COMPUTRABAJO_SITES)) {
    const site = COMPUTRABAJO_SITES[key]!;
    if (!isEnabled(site.country)) continue;
    all[key] = { source: computrabajo(key, regionsFor(key, activeUsers(db, site.country))), maxPages: config.computrabajoMaxPages };
  }
  if (isEnabled("CL")) all.trabajando = { source: trabajando, maxPages: config.trabajandoMaxPages };
  return all;
}

/**
 * Las regiones de Computrabajo que pide el perfil recién guardado y que nadie pedía antes de guardarlo (contando el
 * perfil anterior de la misma persona): las que la corrida todavía no recorre.
 */
export function newRegions(db: DatabaseSync, old: User | null, user: User): { site: string; regions: Region[] } | null {
  const site = computrabajoSite(user.country);
  if (!site || !user.active) return null;
  const others = activeUsers(db, user.country, user.phone);
  const before = old?.active && old.country === user.country ? [...others, old] : others;
  const covered = new Set(regionsFor(site, before).map((r) => r.slug));
  const regions = regionsFor(site, [...others, user]).filter((r) => !covered.has(r.slug));
  return regions.length ? { site, regions } : null;
}

// Una ingesta a la vez: la corrida y las de regiones nuevas comparten el proxy y el ritmo con Computrabajo.
let lane: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = lane.then(fn);
  lane = next.catch(() => {});
  return next;
}

/**
 * Al crear o cambiar un perfil, trae las regiones nuevas de Computrabajo sin esperar a la próxima corrida, que es la
 * que después cruza y manda lo que llegue. Si la fuente está descansando por un bloqueo, no se pide.
 */
export function ingestNewRegions(db: DatabaseSync, embed: Embedder, old: User | null, user: User): Promise<IngestReport | null> {
  const wanted = newRegions(db, old, user);
  if (!wanted) return Promise.resolve(null);
  return exclusive(async () => {
    if (restingSources(db).has(wanted.site)) return null;
    const source = computrabajo(wanted.site, wanted.regions);
    return ingest(db, embed, { [wanted.site]: { source, maxPages: config.computrabajoMaxPages } });
  });
}

let running = false;

/** Una corrida completa: traer avisos nuevos, cruzarlos con cada persona y mandar lo que corresponda. */
export async function runCycle(db: DatabaseSync, embed: Embedder) {
  if (running) return { skipped: "ya hay una corrida en curso" };
  running = true;
  try {
    return await exclusive(() => cycle(db, embed));
  } finally {
    running = false;
  }
}

async function cycle(db: DatabaseSync, embed: Embedder) {
  const run = db.prepare("INSERT INTO ingest_runs (started_at) VALUES (?)").run(now()).lastInsertRowid;
  try {
    const resting = restingSources(db);
    const active = Object.fromEntries(Object.entries(sources(db)).filter(([key]) => !resting.has(key)));
    const ingested: Record<string, unknown> = await ingest(db, embed, active);
    for (const [key, until] of resting) ingested[key] = { added: 0, duplicates: 0, pages: 0, invalid: 0, skipped: `bloqueada (403/429); se reintenta después de ${until}` };
    const matched = await matchAll(db, config.llm.apiKey ? llmJudge : null);
    const notified = config.vatio.serverKey
      ? await notifyAll(db, vatioSender)
      : { skipped: "falta VATIO_SERVER_KEY: los avisos quedan pendientes" };
    const result = { ingested, matched, notified };
    db.prepare("UPDATE ingest_runs SET finished_at = ?, result = ? WHERE id = ?").run(now(), JSON.stringify(result), run);
    return result;
  } catch (e) {
    db.prepare("UPDATE ingest_runs SET finished_at = ?, error = ? WHERE id = ?").run(now(), (e as Error).message, run);
    throw e;
  } finally {
    // Retención: corridas y registro de llamadas de más de API_LOG_RETENTION_DAYS días.
    const cutoff = new Date(Date.now() - config.apiLogRetentionDays * 86_400_000).toISOString();
    db.prepare("DELETE FROM api_log WHERE at < ?").run(cutoff);
    db.prepare("DELETE FROM ingest_runs WHERE started_at < ?").run(cutoff);
  }
}
