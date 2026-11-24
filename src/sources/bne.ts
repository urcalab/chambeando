import { z } from "zod";
import { fetchJson, sleep } from "./http.ts";
import { modalityOf, regionKey, stripHtml } from "../text.ts";
import type { NewJob, Source } from "./types.ts";

/**
 * Bolsa Nacional de Empleo (bne.gob.cl), la bolsa pública y gratuita del Ministerio del Trabajo de Chile. Muchos de
 * sus avisos los publican las OMIL (oficinas municipales de empleo) y no están en otros portales.
 * Se lee la misma API que usa su buscador, que su robots.txt no restringe: `POST /api/ofertas/busqueda` con un filtro
 * vacío devuelve sus avisos propios, del más nuevo al más viejo. Las "ofertas externas" del buscador son copias de
 * otros portales y no se piden.
 */
const API = "https://www.bne.gob.cl/api/ofertas/busqueda";
const PAGE_SIZE = 50;
const PAGE_PAUSE_MS = 1000;

const Named = z.object({ nombre: z.string().nullish() }).nullish();

const Oferta = z.object({
  id: z.number(),
  nombrePuesto: z.string().trim().min(1),
  empresario: z.object({ nombreComercial: z.string().nullish() }).nullish(),
  region: Named,
  comuna: Named,
  rangoSalarial: Named,
  jornadaLaboral: Named,
  fechaPublicacion: z.string().nullish(),
  descripcion: z.string().nullish(),
});

const Page = z.object({ content: z.array(z.unknown()), totalPages: z.number(), last: z.boolean() });

const pesos = (s: string) => Number.parseInt(s.replace(/\D/g, ""), 10);

/**
 * El rango de sueldo ("$610.001 - $760.000", "Más de $3.000.000"), como línea para el mensaje y como cifra para el
 * filtro de sueldo mínimo. La cifra es el tope del rango: el filtro descarta un aviso solo si ni su tope alcanza.
 * Sin tope ("Más de ...") no hay cifra, para no descartar un aviso que podría pagar más.
 */
export function salaryOf(range: string | null | undefined): { salary: number | null; line: string | null } {
  const amounts = (range ?? "").match(/\$\s*\d{1,3}(?:\.\d{3})+/g)?.map(pesos) ?? [];
  const money = (n: number) => `$${n.toLocaleString("es-CL")}`;
  if (amounts.length >= 2) {
    const [min, max] = [Math.min(...amounts), Math.max(...amounts)];
    return { salary: max, line: `Sueldo: ${money(min)} a ${money(max)}.` };
  }
  if (amounts.length === 1) {
    if (/m[aá]s de|sobre|desde/i.test(range!)) return { salary: null, line: `Sueldo: más de ${money(amounts[0]!)}.` };
    if (/menos de|hasta/i.test(range!)) return { salary: amounts[0]!, line: `Sueldo: hasta ${money(amounts[0]!)}.` };
    return { salary: amounts[0]!, line: null };
  }
  return { salary: null, line: null };
}

export function toJob(raw: unknown): NewJob | null {
  const parsed = Oferta.safeParse(raw);
  if (!parsed.success) return null;
  const o = parsed.data;
  const location = [o.comuna?.nombre, o.region?.nombre].filter(Boolean).join(", ") || null;
  const jornada = o.jornadaLaboral?.nombre ?? null;
  const { salary, line } = salaryOf(o.rangoSalarial?.nombre);
  return {
    id: `bne:${o.id}`,
    source: "bne",
    source_id: String(o.id),
    country: "CL",
    url: `https://www.bne.gob.cl/ofertas/${o.id}`,
    title: o.nombrePuesto,
    company: o.empresario?.nombreComercial?.trim() || null,
    location,
    region: regionKey(location),
    modality: modalityOf(jornada),
    job_type: jornada,
    salary,
    // El rango va al comienzo de la descripción: es lo que muestra el mensaje en vez de la cifra sola.
    description: [line, stripHtml(o.descripcion ?? "")].filter(Boolean).join("\n\n"),
    published_at: o.fechaPublicacion ?? null,
  };
}

const post = (url: string) =>
  fetchJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

/** Los avisos propios de la BNE, del más nuevo al más viejo, hasta la primera página sin nada nuevo. */
export function bne(get: (url: string) => Promise<unknown> = post): Source {
  return async ({ maxPages, isKnown }) => {
    const jobs: NewJob[] = [];
    let invalid = 0;
    let pages = 0;
    for (let page = 0; page < maxPages; page++) {
      const body = Page.parse(await get(`${API}?page=${page}&size=${PAGE_SIZE}`));
      pages++;
      let fresh = 0;
      for (const raw of body.content) {
        const job = toJob(raw);
        if (!job) {
          invalid++;
          continue;
        }
        if (isKnown(job.id)) continue;
        jobs.push(job);
        fresh++;
      }
      if (fresh === 0 || body.last) break;
      await sleep(PAGE_PAUSE_MS);
    }
    return { jobs, pages, invalid };
  };
}
