import { z } from "zod";
import { fetchJson, sleep } from "./http.ts";
import { modalityOf, regionKey, slugify, stripHtml } from "../text.ts";
import type { NewJob, Source } from "./types.ts";

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

/** "20-11-2026 21:28:25" -> "2026-11-20 21:28" (hora de Chile, como la publica el portal). */
export function parseLaborumDate(s: string | null | undefined): string | null {
  const m = s?.match(/^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}` : null;
}

export function toJob(raw: unknown): NewJob | null {
  const p = Aviso.safeParse(raw);
  if (!p.success) return null;
  const a = p.data;
  return {
    id: `laborum:${a.id}`,
    source: "laborum",
    source_id: String(a.id),
    url: `https://www.laborum.cl/empleos/${slugify(a.titulo)}-${a.id}.html`,
    title: a.titulo.trim(),
    company: a.empresa && a.empresa !== "Confidencial" ? a.empresa : null,
    location: a.localizacion ?? null,
    region: regionKey(a.localizacion),
    modality: modalityOf(a.modalidadTrabajo),
    job_type: a.tipoTrabajo ?? null,
    salary: null,
    description: stripHtml(a.detalle ?? ""),
    published_at: parseLaborumDate(a.fechaHoraPublicacion),
  };
}

export const laborum: Source = async ({ maxPages, isKnown }) => {
  const jobs: NewJob[] = [];
  let invalid = 0;
  let pages = 0;
  for (let page = 0; page < maxPages; page++) {
    const data = Page.parse(
      await fetchJson(
        `https://www.laborum.cl/api/avisos/searchV2?pageSize=${PAGE_SIZE}&page=${page}&sort=RECIENTES`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-site-id": "BMCL",
            referer: "https://www.laborum.cl/empleos.html",
          },
          body: JSON.stringify({ filtros: [] }),
        },
      ),
    );
    pages++;
    let fresh = 0;
    for (const raw of data.content) {
      const job = toJob(raw);
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
