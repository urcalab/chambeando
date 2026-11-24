import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { ZodError } from "zod";
import { config } from "./config.ts";
import { ingestNewRegions, runCycle } from "./cycle.ts";
import { openDb } from "./db.ts";
import { llmJudge, type Judge } from "./llm.ts";
import { localEmbedder, type Embedder } from "./embed.ts";
import { createAdmin, logCall } from "./admin.ts";
import { recordClick, stats } from "./feedback.ts";
import { normalizePhone } from "./text.ts";
import { ToolError, createTools, type ToolHooks } from "./tools.ts";

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

// La landing es una página estática; se lee una vez al arrancar. En producción la raíz la responde un Worker de
// Cloudflare (landing/wrangler.jsonc) y esta copia no recibe tráfico: queda como respaldo si se quita la ruta del Worker.
const LANDING = (() => {
  try {
    return readFileSync(new URL("../site/index.html", import.meta.url));
  } catch {
    return null;
  }
})();

function clientIp(req: IncomingMessage): string | null {
  const h = (name: string) => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  return h("cf-connecting-ip") ?? h("x-forwarded-for")?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? null;
}

const num = (v: string | null, fallback: number, max: number) => Math.min(Math.max(Number(v) || fallback, 1), max);

export function createApp(
  db: DatabaseSync,
  embed: Embedder,
  apiKey: string,
  judge: Judge | null = null,
  adminKey = config.adminApiKey,
  hooks: ToolHooks = {},
) {
  const tools = createTools(db, embed, judge, hooks);
  const admin = createAdmin(db);
  return createServer(async (req, res) => {
    const started = performance.now();
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    // Para el registro forense: quién llamó y, si la llamada trae un teléfono, a quién se refiere.
    const audit: { caller: string; phone: string | null; error: string | null; skip: boolean } = {
      caller: "anon", phone: null, error: null, skip: path === "/health" || path === "/" || path === "/index.html",
    };
    res.on("finish", () => {
      if (audit.skip) return;
      try {
        logCall(db, { method: req.method ?? "?", path: path + url.search, status: res.statusCode, ms: performance.now() - started,
          caller: audit.caller, ip: clientIp(req), phone: audit.phone, error: audit.error });
      } catch (e) {
        console.error("no se pudo registrar la llamada:", e);
      }
    });
    try {
      if ((req.method === "GET" || req.method === "HEAD") && (path === "/" || path === "/index.html") && LANDING) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" });
        return res.end(req.method === "HEAD" ? undefined : LANDING);
      }
      if (req.method === "GET" && path === "/health") {
        const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
        return send(res, 200, { ok: true, jobs: count("jobs"), users: count("users") });
      }
      // Links de los avisos: públicos, cuentan el clic y redirigen al portal.
      const token = req.method === "GET" ? path.match(/^\/r\/([A-Za-z0-9_-]{1,32})$/)?.[1] : undefined;
      if (token) {
        const target = recordClick(db, token);
        if (!target) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          return res.end("Este aviso ya no está disponible.");
        }
        res.writeHead(302, { location: target, "cache-control": "no-store", "referrer-policy": "no-referrer" });
        return res.end();
      }
      if (path.startsWith("/admin/")) {
        if (!adminKey) return send(res, 503, { error: "La consola está apagada: falta ADMIN_API_KEY" });
        if (!authorized(req, adminKey)) return send(res, 401, { error: "No autorizado" });
        audit.caller = "admin";
        if (req.method !== "GET") return send(res, 405, { error: "La consola es de solo lectura" });
        const q = url.searchParams;
        if (path === "/admin/overview") return send(res, 200, admin.overview(num(q.get("days"), 7, 90)));
        if (path === "/admin/sources") return send(res, 200, admin.sources());
        if (path === "/admin/users") return send(res, 200, admin.users(num(q.get("limit"), 100, 1000)));
        const userId = path.match(/^\/admin\/users\/([0-9a-f]{16})$/)?.[1];
        if (userId) {
          const user = admin.user(userId);
          return user ? send(res, 200, user) : send(res, 404, { error: "No existe" });
        }
        if (path === "/admin/runs") return send(res, 200, admin.runs(num(q.get("limit"), 24, 500)));
        if (path === "/admin/log") {
          return send(res, 200, admin.log({
            limit: num(q.get("limit"), 200, 2000), path: q.get("path") ?? undefined,
            caller: q.get("caller") ?? undefined, status: Number(q.get("status")) || undefined,
          }));
        }
        return send(res, 404, { error: "No existe" });
      }
      if (!authorized(req, apiKey)) return send(res, 401, { error: "No autorizado" });
      audit.caller = "backend"; // la clave que usa Vatio para las herramientas
      if (req.method === "GET" && path === "/stats") {
        const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 7, 1), 90);
        return send(res, 200, stats(db, days));
      }
      const name = path.match(/^\/tools\/([a-z_]+)$/)?.[1];
      if (req.method === "POST" && name && Object.hasOwn(tools, name)) {
        const body = await readJson(req);
        const phone = (body as { phone?: unknown })?.phone;
        if (typeof phone === "string") audit.phone = normalizePhone(phone);
        return send(res, 200, await tools[name as keyof typeof tools](body));
      }
      if (req.method === "POST" && path === "/run") return send(res, 200, await runCycle(db, embed));
      send(res, 404, { error: "No existe" });
    } catch (e) {
      audit.error = (e as Error).message;
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
  // Un perfil nuevo o cambiado puede pedir regiones que la corrida no recorre: se traen en segundo plano.
  const hooks: ToolHooks = {
    profileSaved: (old, user) => {
      Promise.resolve()
        .then(() => ingestNewRegions(db, localEmbedder, old, user))
        .then((r) => r && console.log(new Date().toISOString(), "regiones nuevas:", JSON.stringify(r)))
        .catch((e) => console.error("ingesta de regiones nuevas falló:", e));
    },
  };
  createApp(db, localEmbedder, config.backendApiKey, config.llm.apiKey ? llmJudge : null, config.adminApiKey, hooks).listen(config.port, () => {
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
