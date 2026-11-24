import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { now } from "./db.ts";
import type { Embedder } from "./embed.ts";
import { ingest } from "./ingest.ts";
import { llmJudge } from "./llm.ts";
import { matchAll } from "./match.ts";
import { notifyAll, vatioSender } from "./notify.ts";
import { COMPUTRABAJO_SITES, computrabajo } from "./sources/computrabajo.ts";
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

export function sources(): Record<string, { source: Source; maxPages: number }> {
  const all: Record<string, { source: Source; maxPages: number }> = {};
  // Solo se traen avisos de los países abiertos.
  for (const key of config.jobintSites) {
    if (isEnabled(JOBINT_SITES[key]!.country)) all[key] = { source: jobint(key), maxPages: config.jobintMaxPages };
  }
  for (const key of config.computrabajoSites ?? Object.keys(COMPUTRABAJO_SITES)) {
    if (isEnabled(COMPUTRABAJO_SITES[key]!.country)) all[key] = { source: computrabajo(key), maxPages: config.computrabajoMaxPages };
  }
  if (isEnabled("CL")) all.trabajando = { source: trabajando, maxPages: config.trabajandoMaxPages };
  return all;
}

let running = false;

/** Una corrida completa: traer avisos nuevos, cruzarlos con cada persona y mandar lo que corresponda. */
export async function runCycle(db: DatabaseSync, embed: Embedder) {
  if (running) return { skipped: "ya hay una corrida en curso" };
  running = true;
  const run = db.prepare("INSERT INTO ingest_runs (started_at) VALUES (?)").run(now()).lastInsertRowid;
  try {
    const resting = restingSources(db);
    const active = Object.fromEntries(Object.entries(sources()).filter(([key]) => !resting.has(key)));
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
    running = false;
  }
}
