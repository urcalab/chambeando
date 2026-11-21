import { z } from "zod";
import { fetchJson, sleep } from "./http.ts";
import { modalityOf, regionOf, slugify, stripHtml, type Country } from "../text.ts";
import type { NewJob, Source } from "./types.ts";

/**
 * Jobint opera el mismo portal con distintas marcas por país (Laborum en Chile, Bumeran,
 * Multitrabajos, Konzerta). Todos exponen la misma API; cambia el dominio y el `x-site-id`.
 */
export const JOBINT_SITES: Record<string, { country: Country; domain: string; siteId: string; portal: string }> = {
  laborum: { country: "CL", domain: "www.laborum.cl", siteId: "BMCL", portal: "laborum" },
  "bumeran-ar": { country: "AR", domain: "www.bumeran.com.ar", siteId: "BMAR", portal: "bumeran" },
  "bumeran-mx": { country: "MX", domain: "www.bumeran.com.mx", siteId: "BMMX", portal: "bumeran" },
  "bumeran-pe": { country: "PE", domain: "www.bumeran.com.pe", siteId: "BMPE", portal: "bumeran" },
  multitrabajos: { country: "EC", domain: "www.multitrabajos.com", siteId: "BMEC", portal: "multitrabajos" },
  konzerta: { country: "PA", domain: "www.konzerta.com", siteId: "BMPA", portal: "konzerta" },
  "bumeran-ve": { country: "VE", domain: "www.bumeran.com.ve", siteId: "BMVE", portal: "bumeran" },
};

const Aviso = z.object({
  id: z.number(),
  titulo: z.string().min(1),
  detalle: z.string().nullish(),
  empresa: z.string().nullish(),
  localizacion: z.string().nullish(),
  modalidadTrabajo: z.string().nullish(),
  tipoTrabajo: z.string().nullish(),
  fechaHoraPublicacion: z.string().nullish(),
});
const Page = z.object({ total: z.number(), content: z.array(z.unknown()) });

const PAGE_SIZE = 100;

/** "20-11-2026 21:28:25" -> "2026-11-20 21:28" (hora local del país, como la publica el portal). */
export function parseJobintDate(s: string | null | undefined): string | null {
  const m = s?.match(/^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}` : null;
}

export function toJob(raw: unknown, siteKey: string): NewJob | null {
  const site = JOBINT_SITES[siteKey]!;
  const p = Aviso.safeParse(raw);
  if (!p.success) return null;
  const a = p.data;
  return {
    id: `${siteKey}:${a.id}`,
    source: site.portal,
    source_id: String(a.id),
    country: site.country,
    url: `https://${site.domain}/empleos/${slugify(a.titulo)}-${a.id}.html`,
    title: a.titulo.trim(),
    company: a.empresa && a.empresa !== "Confidencial" ? a.empresa : null,
    location: a.localizacion ?? null,
    region: regionOf(site.country, a.localizacion),
    modality: modalityOf(a.modalidadTrabajo),
    job_type: a.tipoTrabajo ?? null,
    salary: null,
    description: stripHtml(a.detalle ?? ""),
    published_at: parseJobintDate(a.fechaHoraPublicacion),
  };
}

export function jobint(siteKey: string): Source {
  const site = JOBINT_SITES[siteKey];
  if (!site) throw new Error(`Sitio Jobint desconocido: ${siteKey}`);
  return async ({ maxPages, isKnown }) => {
    const jobs: NewJob[] = [];
    let invalid = 0;
    let pages = 0;
    for (let page = 0; page < maxPages; page++) {
      const data = Page.parse(
        await fetchJson(
          `https://${site.domain}/api/avisos/searchV2?pageSize=${PAGE_SIZE}&page=${page}&sort=RECIENTES`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-site-id": site.siteId,
              referer: `https://${site.domain}/empleos.html`,
            },
            body: JSON.stringify({ filtros: [] }),
          },
        ),
      );
      pages++;
      let fresh = 0;
      for (const raw of data.content) {
        const job = toJob(raw, siteKey);
        if (!job) invalid++;
        else if (!isKnown(job.id)) {
          jobs.push(job);
          fresh++;
        }
      }
      // Una página sin nada nuevo: ya alcanzamos lo que teníamos.
      if (fresh === 0 || data.content.length < PAGE_SIZE) break;
      await sleep(1500);
    }
    return { jobs, pages, invalid };
  };
}
