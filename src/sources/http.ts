import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Un agente se reutiliza durante toda la corrida para mantener las conexiones del proxy.
const proxyAgents = new Map<string, Dispatcher>();

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function proxyDispatcher(proxyUrl: string): Dispatcher {
  let agent = proxyAgents.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    proxyAgents.set(proxyUrl, agent);
  }
  return agent;
}

/** Pide una página HTML a un portal, opcionalmente a través de un proxy HTTP(S). */
export async function fetchText(url: string, proxyUrl?: string): Promise<string> {
  const options = {
    headers: { "user-agent": UA, accept: "text/html", "accept-language": "es" },
    signal: AbortSignal.timeout(30_000),
  };
  const res = proxyUrl
    ? await undiciFetch(url, { ...options, dispatcher: proxyDispatcher(proxyUrl) })
    : await fetch(url, options);
  if (!res.ok) throw new Error(`${url} respondió ${res.status}`);
  return res.text();
}

/** Pide JSON a un portal. Falla con un mensaje claro si llega otra cosa (por ejemplo la página de Cloudflare). */
export async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { "user-agent": UA, accept: "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${url} respondió ${res.status}: ${body.slice(0, 120)}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${url} no devolvió JSON (¿bloqueo del portal?): ${body.slice(0, 120)}`);
  }
}
