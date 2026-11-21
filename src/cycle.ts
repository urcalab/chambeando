import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import type { Embedder } from "./embed.ts";
import { ingest } from "./ingest.ts";
import { llmJudge } from "./llm.ts";
import { matchAll } from "./match.ts";
import { notifyAll, vatioSender } from "./notify.ts";
import { laborum } from "./sources/laborum.ts";
import { trabajando } from "./sources/trabajando.ts";

export const sources = () => ({
  laborum: { source: laborum, maxPages: config.laborumMaxPages },
  trabajando: { source: trabajando, maxPages: config.trabajandoMaxPages },
});

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
