import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { ZodError } from "zod";
import { config } from "./config.ts";
import { runCycle } from "./cycle.ts";
import { openDb } from "./db.ts";
import { llmJudge, type Judge } from "./llm.ts";
import { localEmbedder, type Embedder } from "./embed.ts";
import { recordClick, stats } from "./feedback.ts";
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

// La landing es una página estática; se lee una vez al arrancar.
const LANDING = (() => {
  try {
    return readFileSync(new URL("../site/index.html", import.meta.url));
  } catch {
    return null;
  }
})();

export function createApp(db: DatabaseSync, embed: Embedder, apiKey: string, judge: Judge | null = null) {
  const tools = createTools(db, embed, judge);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      if ((req.method === "GET" || req.method === "HEAD") && (path === "/" || path === "/index.html") && LANDING) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" });
        return res.end(req.method === "HEAD" ? undefined : LANDING);
      }
      if (req.method === "GET" && path === "/health") {
        const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
        return send(res, 200, { ok: true, jobs: count("jobs"), users: count("users") });
      }
      // Links de los avisos: públicos, cuentan el clic y redirigen al portal.
      const token = req.method === "GET" ? path.match(/^\/r\/([A-Za-z0-9_-]{8,32})$/)?.[1] : undefined;
      if (token) {
        const target = recordClick(db, token);
        if (!target) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          return res.end("Este aviso ya no está disponible.");
        }
        res.writeHead(302, { location: target, "cache-control": "no-store", "referrer-policy": "no-referrer" });
        return res.end();
      }
      if (!authorized(req, apiKey)) return send(res, 401, { error: "No autorizado" });
      if (req.method === "GET" && path === "/stats") {
        const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 7, 1), 90);
        return send(res, 200, stats(db, days));
      }
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
