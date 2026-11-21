import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { ZodError } from "zod";
import { config } from "./config.ts";
import { runCycle } from "./cycle.ts";
import { openDb } from "./db.ts";
import { llmJudge, type Judge } from "./llm.ts";
import { localEmbedder, type Embedder } from "./embed.ts";
import { ToolError, createTools } from "./tools.ts";

function authorized(req: IncomingMessage, key: string): boolean {
  const given = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${key}`);
  return key.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 100_000) throw new ToolError(413, "Cuerpo demasiado grande");
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new ToolError(400, "El cuerpo no es JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function createApp(db: DatabaseSync, embed: Embedder, apiKey: string, judge: Judge | null = null) {
  const tools = createTools(db, embed, judge);
  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (req.method === "GET" && path === "/health") {
        const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
        return send(res, 200, { ok: true, jobs: count("jobs"), users: count("users") });
      }
      if (!authorized(req, apiKey)) return send(res, 401, { error: "No autorizado" });
      const name = path.match(/^\/tools\/([a-z_]+)$/)?.[1];
      if (req.method === "POST" && name && Object.hasOwn(tools, name)) {
        return send(res, 200, await tools[name as keyof typeof tools](await readJson(req)));
      }
      if (req.method === "POST" && path === "/run") return send(res, 200, await runCycle(db, embed));
      send(res, 404, { error: "No existe" });
    } catch (e) {
      if (e instanceof ToolError) return send(res, e.status, { error: e.message });
      if (e instanceof ZodError) {
        return send(res, 422, { error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      }
      console.error(e);
      send(res, 500, { error: "Error interno" });
    }
  });
}

if (import.meta.main) {
  if (!config.backendApiKey) throw new Error("Falta BACKEND_API_KEY");
  const db = openDb(config.dbPath);
  createApp(db, localEmbedder, config.backendApiKey, config.llm.apiKey ? llmJudge : null).listen(config.port, () => {
    console.log(`chambeando escuchando en :${config.port}`);
  });
  const tick = () =>
    runCycle(db, localEmbedder)
      .then((r) => console.log(new Date().toISOString(), JSON.stringify(r)))
      .catch((e) => console.error("corrida falló:", e));
  tick();
  // setInterval desborda sobre 2^31 ms (~24 días) y pasaría a disparar sin pausa.
  setInterval(tick, Math.min(config.ingestEveryMinutes * 60_000, 2 ** 31 - 1));
}
