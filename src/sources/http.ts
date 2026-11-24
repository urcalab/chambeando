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

/** Cierra las conexiones abiertas con el proxy, para que el próximo pedido salga por un túnel nuevo (y otra IP). */
function rotateProxy(proxyUrl: string): void {
  const agent = proxyAgents.get(proxyUrl);
  proxyAgents.delete(proxyUrl);
  agent?.close().catch(() => {});
}

/** Un portal respondió con un código de error. El mensaje ("… respondió 403") es lo que mira el descanso de fuentes. */
export class HttpError extends Error {
  status: number;
  constructor(url: string, status: number) {
    super(`${url} respondió ${status}`);
    this.status = status;
  }
}

/** Intentos por pedido a través del proxy: cada intento sale por otra IP, y algunas de esas IPs están bloqueadas. */
export const PROXY_ATTEMPTS = 4;

/** Un bloqueo (403, 429), un error del servidor, un timeout o un corte de red: vale la pena reintentar. Un 404 no. */
export function retryable(e: unknown): boolean {
  return !(e instanceof HttpError) || e.status === 403 || e.status === 429 || e.status >= 500;
}

/** Corre `fn` hasta `attempts` veces mientras falle con algo que vale la pena reintentar; si no, lanza el último error. */
export async function withRetries<T>(
  attempts: number,
  fn: () => Promise<T>,
  onRetry: () => void = () => {},
  pauseMs = 1000,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts || !retryable(e)) throw e;
      onRetry();
      await sleep(pauseMs * attempt);
    }
  }
}

async function fetchOnce(url: string, proxyUrl?: string): Promise<string> {
  const options = {
    headers: { "user-agent": UA, accept: "text/html", "accept-language": "es" },
    signal: AbortSignal.timeout(30_000),
  };
  const res = proxyUrl
    ? await undiciFetch(url, { ...options, dispatcher: proxyDispatcher(proxyUrl) })
    : await fetch(url, options);
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new HttpError(url, res.status);
  }
  return res.text();
}

/**
 * Pide una página HTML a un portal, opcionalmente a través de un proxy HTTP(S). Por el proxy, un bloqueo se reintenta
 * por un túnel nuevo; sin proxy no, porque desde la misma IP insistir solo alarga el bloqueo.
 */
export async function fetchText(url: string, proxyUrl?: string): Promise<string> {
  if (!proxyUrl) return fetchOnce(url);
  return withRetries(PROXY_ATTEMPTS, () => fetchOnce(url, proxyUrl), () => rotateProxy(proxyUrl));
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
