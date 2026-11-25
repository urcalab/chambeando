import { z } from "zod";
import { fetchText, sleep } from "./http.ts";
import { decodeEntities, localNow, modalityOf, normalize, regionKey, stripHtml } from "../text.ts";
import type { NewJob, Source } from "./types.ts";

/**
 * Chiletrabajos (chiletrabajos.cl): avisos de Chile, muchos de oficios, bodega, ventas y atención. No tiene API: el
 * listado es HTML y cada aviso trae sus datos como JSON-LD (JobPosting). Su robots.txt solo cierra `/partners/` y
 * `/ofertasmuchomas`.
 * El listado "por fecha" ordena por día, no por hora: dentro del día los destacados van primero, mezclados, y el resto
 * no sigue el orden de publicación. Cortar en la primera página sin nada nuevo perdería avisos, así que cada corrida
 * recorre entero el listado de hoy (de 1 a unas 45 páginas de 30 avisos) y pide el detalle solo de lo que no conocemos.
 */
const BASE = "https://www.chiletrabajos.cl";
const PAGE_SIZE = 30;
const PAGE_PAUSE_MS = 1000;
const DETAIL_PAUSE_MS = 600;
/** Detalles por corrida. La primera vez todo el día es nuevo (más de mil avisos): el resto queda para las siguientes. */
export const MAX_DETAILS = 200;

/**
 * Página del listado, de los avisos de hoy (`fecha=1`) o desde ayer (`fecha=2`), por fecha (`f=2`). Las páginas
 * siguientes van por desplazamiento: /encuentra-un-empleo/30, /60...
 */
export function listingUrl(since: 1 | 2, page: number): string {
  return `${BASE}/encuentra-un-empleo${page > 1 ? `/${(page - 1) * PAGE_SIZE}` : ""}?fecha=${since}&f=2`;
}

export type Listed = { id: string; url: string; title: string };

/**
 * Cuántos avisos tiene el listado y los de esta página. El total va en un título: "1069 Trabajos" en el listado
 * filtrado por fecha, "Se han encontrado 34270 trabajos" en el completo. `total` null: no es un listado.
 */
export function parseListing(html: string): { total: number | null; items: Listed[] } {
  const total = html.match(/<h2[^>]*>\s*(?:Se han encontrado\s+)?(\d+)\s+trabajos\s*<\/h2>/i)?.[1];
  const items: Listed[] = [];
  for (const block of html.split('<div class="job-item').slice(1)) {
    const link = block.match(/<h2 class="title[^"]*">\s*<a href="(https:\/\/www\.chiletrabajos\.cl\/trabajo\/[^"]*?-(\d+))"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    // El título del listado viene cortado ("VENDEDOR / BODEGUERO CON LICENCIA CLASE…"): el completo está en el detalle.
    items.push({ url: link[1]!, id: link[2]!, title: decodeEntities(link[3]!).replace(/\s+/g, " ").trim() });
  }
  return { total: total ? Number(total) : null, items };
}

const Amount = z.union([z.number(), z.string()]).nullish();

const Posting = z.object({
  "@type": z.literal("JobPosting"),
  title: z.string().nullish(),
  description: z.string().nullish(),
  datePosted: z.string().nullish(),
  employmentType: z.union([z.string(), z.array(z.string())]).nullish(),
  industry: z.string().nullish(),
  jobLocation: z
    .object({ address: z.object({ addressLocality: z.string().nullish(), addressRegion: z.string().nullish() }).nullish() })
    .nullish(),
  baseSalary: z
    .object({
      currency: z.string().nullish(),
      // Chiletrabajos escribe "Value", con mayúscula.
      value: z.object({ Value: Amount, value: Amount, unitText: z.string().nullish() }).nullish(),
    })
    .nullish(),
  hiringOrganization: z.object({ name: z.string().nullish() }).nullish(),
});

/** El JobPosting de la página de un aviso, o null si no viene o cambió de forma. */
export function parsePosting(html: string): z.infer<typeof Posting> | null {
  for (const m of html.matchAll(/<script type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/g)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]!);
    } catch {
      // Un salto de línea o tabulación sin escapar dentro del texto invalida el JSON: se cambian por espacios.
      try {
        data = JSON.parse(m[1]!.replace(/[\u0000-\u001f]+/g, " "));
      } catch {
        continue;
      }
    }
    const p = Posting.safeParse(data);
    if (p.success) return p.data;
  }
  return null;
}

/** La región, por su código ISO 3166-2:CL ("RM", "BI"), con un nombre que `regionKey` reconoce. */
const REGION_NAMES: Record<string, string> = {
  AP: "Arica y Parinacota", TA: "Tarapacá", AN: "Antofagasta", AT: "Atacama", CO: "Coquimbo", VS: "Valparaíso",
  RM: "Metropolitana", LI: "O'Higgins", ML: "Maule", NB: "Ñuble", BI: "Biobío", AR: "Araucanía", LR: "Los Ríos",
  LL: "Los Lagos", AI: "Aysén", MA: "Magallanes",
};

/** "Confidencial", "Empresa confidencial", "ANÓNIMO", "Importante empresa": no dicen quién contrata. */
function companyOf(name: string | null | undefined): string | null {
  const n = normalize(name ?? "");
  if (!n || /\b(confidencial|anonim[oa])\b/.test(n) || /^importante\b/.test(n)) return null;
  return decodeEntities(name!).trim();
}

/** El sueldo mensual en pesos. Un 0 es "a convenir". */
function salaryOf(p: z.infer<typeof Posting>): number | null {
  const s = p.baseSalary;
  const amount = Number(s?.value?.Value ?? s?.value?.value ?? NaN);
  if (s?.value?.unitText !== "MONTH" || (s.currency && s.currency !== "CLP")) return null;
  return Number.isFinite(amount) && amount >= 10_000 ? Math.round(amount) : null;
}

export function toJob(listed: Listed, detailHtml: string): NewJob | null {
  const p = parsePosting(detailHtml);
  if (!p) return null;
  const title = decodeEntities(p.title ?? listed.title).replace(/\s+/g, " ").trim();
  if (!title) return null;
  const address = p.jobLocation?.address;
  const regionName = REGION_NAMES[(address?.addressRegion ?? "").toUpperCase()];
  const location = [address?.addressLocality?.trim(), regionName].filter(Boolean).join(", ") || null;
  const description = stripHtml((p.description ?? "").replace(/\r\n?/g, "\n"));
  // No hay campo de modalidad: se lee del título o de una línea "Modalidad: ..." de la descripción.
  const modality = modalityOf(title) ?? modalityOf(/modalidad[^:\n]{0,20}:\s*([^\n]+)/i.exec(description)?.[1]);
  const employment = Array.isArray(p.employmentType) ? p.employmentType.join(", ") : (p.employmentType ?? null);
  // Las prácticas son una categoría ("Prácticas profesionales") y suelen publicarse como FULL_TIME: se anteponen para jobKind.
  const practice = /\bpracticas?\b/.test(normalize(p.industry ?? ""));
  return {
    id: `chiletrabajos:${listed.id}`,
    source: "chiletrabajos",
    source_id: listed.id,
    country: "CL",
    url: listed.url,
    title,
    company: companyOf(p.hiringOrganization?.name),
    location,
    region: regionKey(location),
    modality,
    job_type: practice ? ["Práctica", employment].filter(Boolean).join(", ") : employment,
    salary: salaryOf(p),
    description,
    // Hora de Chile, como la escribe el portal ("2026-11-24 09:39:24").
    published_at: p.datePosted && /^\d{4}-\d{2}-\d{2}/.test(p.datePosted) ? p.datePosted : null,
  };
}

/**
 * Recorre el listado de hoy y trae el detalle de los avisos que no conocemos, hasta `maxDetails` por corrida.
 * Recorre desde ayer en dos casos:
 * - Las primeras horas del día, para no perder lo publicado después de la última corrida de la noche.
 * - Cuando en UTC ya es mañana (desde las 21 en Chile, o las 20 en invierno): el portal decide qué es "hoy" con la
 *   fecha UTC, y a esa hora "hoy" viene vacío aunque haya avisos de hace un rato.
 */
export function chiletrabajos({
  get = (url: string) => fetchText(url),
  now = () => new Date(),
  pause = sleep,
  maxDetails = MAX_DETAILS,
}: {
  get?: (url: string) => Promise<string>;
  now?: () => Date;
  pause?: (ms: number) => Promise<unknown>;
  maxDetails?: number;
} = {}): Source {
  return async ({ maxPages, isKnown }) => {
    const at = now();
    const chile = localNow("CL", at);
    const since = chile.hour < 2 || chile.date !== at.toISOString().slice(0, 10) ? 2 : 1;
    const jobs: NewJob[] = [];
    const seen = new Set<string>();
    let invalid = 0;
    let pages = 0;
    let details = 0;
    let last = 1;
    let capped = false;
    for (let page = 1; page <= Math.min(last, maxPages) && !capped; page++) {
      const url = listingUrl(since, page);
      const { total, items } = parseListing(await get(url));
      pages++;
      if (total === null) throw new Error(`${url} no trae el listado (¿bloqueo o cambio del HTML?)`);
      // Con 0 avisos igual viene una página, con los destacados.
      last = Math.max(1, Math.ceil(total / PAGE_SIZE));
      for (const item of items) {
        const id = `chiletrabajos:${item.id}`;
        if (seen.has(id) || isKnown(id)) continue;
        if (details >= maxDetails) {
          capped = true;
          break;
        }
        seen.add(id);
        details++;
        // Un aviso que falla (despublicado entre el listado y el detalle) no detiene la corrida.
        const job = await get(item.url).then((html) => toJob(item, html)).catch(() => null);
        if (job) jobs.push(job);
        else invalid++;
        await pause(DETAIL_PAUSE_MS);
      }
      if (page < Math.min(last, maxPages) && !capped) await pause(PAGE_PAUSE_MS);
    }
    const note = `${since === 1 ? "hoy" : "desde ayer"}: ${pages} de ${last} páginas` +
      (capped ? `; tope de ${maxDetails} detalles, el resto queda para la próxima corrida` : "");
    return { jobs, pages, invalid, note };
  };
}
