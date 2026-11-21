const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
