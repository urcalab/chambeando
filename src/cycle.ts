import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import type { Embedder } from "./embed.ts";
import { ingest } from "./ingest.ts";
import { llmJudge } from "./llm.ts";
import { matchAll } from "./match.ts";
import { notifyAll, vatioSender } from "./notify.ts";
import { computrabajo } from "./sources/computrabajo.ts";
import { jobint } from "./sources/jobint.ts";
import type { Source } from "./sources/types.ts";
import { trabajando } from "./sources/trabajando.ts";

export function sources(): Record<string, { source: Source; maxPages: number }> {
  const all: Record<string, { source: Source; maxPages: number }> = {};
  for (const key of config.jobintSites) all[key] = { source: jobint(key), maxPages: config.jobintMaxPages };
  for (const key of config.computrabajoSites) all[key] = { source: computrabajo(key), maxPages: config.computrabajoMaxPages };
  all.trabajando = { source: trabajando, maxPages: config.trabajandoMaxPages };
  return all;
}

let running = false;

/** Una corrida completa: traer avisos nuevos, cruzarlos con cada persona y mandar lo que corresponda. */
export async function runCycle(db: DatabaseSync, embed: Embedder) {
  if (running) return { skipped: "ya hay una corrida en curso" };
  running = true;
  try {
    const ingested = await ingest(db, embed, sources());
    const matched = await matchAll(db, config.llm.apiKey ? llmJudge : null);
    const notified = config.vatio.serverKey
      ? await notifyAll(db, vatioSender)
      : { skipped: "falta VATIO_SERVER_KEY: los avisos quedan pendientes" };
    return { ingested, matched, notified };
  } finally {
    running = false;
  }
}
