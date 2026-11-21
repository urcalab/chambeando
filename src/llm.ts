import { config } from "./config.ts";
import type { Job, User } from "./db.ts";
import { COUNTRIES } from "./text.ts";

export type Verdict = { ok: boolean; reason: string };
export type PastFeedback = { title: string; useful: boolean; feedback: string | null };

/** Decide cuáles de los avisos candidatos le sirven de verdad a un usuario. */
export type Judge = (user: User, past: PastFeedback[], jobs: Job[]) => Promise<Verdict[]>;

export function buildPrompt(user: User, past: PastFeedback[], jobs: Job[]): string {
  const profile = [
    `País: ${COUNTRIES[user.country]}`,
    `Lo que busca: ${user.summary}`,
    user.roles.length ? `Cargos: ${user.roles.join(", ")}` : "",
    user.regions.length ? `Regiones: ${user.regions.join(", ")}` : "Regiones: cualquiera",
    user.modalities.length ? `Modalidad: ${user.modalities.join(", ")}` : "",
    user.min_salary ? `Sueldo mensual mínimo, en moneda local: ${user.min_salary}` : "",
    user.exclude.length ? `No quiere: ${user.exclude.join(", ")}` : "",
  ].filter(Boolean);
  const history = past.map(
    (p) => `- "${p.title}": ${p.useful ? "le sirvió" : "no le sirvió"}${p.feedback ? ` (${p.feedback})` : ""}`,
  );
  const list = jobs.map((j, i) =>
    [
      `### Aviso ${i + 1}`,
      `Cargo: ${j.title}`,
      `Empresa: ${j.company ?? "confidencial"} | Lugar: ${j.location ?? "?"} | Modalidad: ${j.modality ?? "?"} | Jornada: ${j.job_type ?? "?"} | Sueldo: ${j.salary ?? "no informado"}`,
      j.description.slice(0, 1500),
    ].join("\n"),
  );
  return [
    "Eres el filtro de un servicio que avisa por WhatsApp de ofertas de trabajo en Latinoamérica.",
    "Una persona recibe pocos avisos al día, así que solo debe llegarle uno si de verdad postularía:",
    "el cargo corresponde a su profesión y nivel, y nada de lo que pidió excluir aparece.",
    "Ante la duda, no sirve. Que el aviso no informe sueldo o modalidad no lo descarta.",
    "",
    "## Persona",
    ...profile,
    ...(history.length ? ["", "## Lo que dijo de avisos anteriores", ...history] : []),
    "",
    "## Avisos candidatos",
    ...list,
    "",
    `Responde solo con JSON: {"avisos":[{"n":1,"sirve":true,"motivo":"una frase corta, sin comillas dobles"}]} con los ${jobs.length} avisos.`,
  ].join("\n");
}

export function parseVerdicts(text: string, count: number): Verdict[] {
  const verdicts: Verdict[] = Array.from({ length: count }, () => ({ ok: false, reason: "" }));
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`El modelo no devolvió JSON: ${text.slice(0, 120)}`);
  const parsed = JSON.parse(text.slice(start, end + 1)) as { avisos?: Array<Record<string, unknown>> };
  for (const a of parsed.avisos ?? []) {
    const i = Number(a.n) - 1;
    if (verdicts[i]) verdicts[i] = { ok: a.sirve === true, reason: String(a.motivo ?? "") };
  }
  return verdicts;
}

async function ask(prompt: string): Promise<string> {
  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.llm.apiKey}` },
    body: JSON.stringify({
      model: config.llm.model,
      // Holgado: los modelos que razonan antes de responder gastan parte de este tope en eso.
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`El modelo respondió ${res.status}: ${body.slice(0, 200)}`);
  const content = JSON.parse(body).choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content) throw new Error("El modelo respondió sin contenido");
  return content;
}

export const llmJudge: Judge = async (user, past, jobs) => {
  const prompt = buildPrompt(user, past, jobs);
  try {
    return parseVerdicts(await ask(prompt), jobs.length);
  } catch {
    // Una respuesta vacía o con JSON mal formado suele salir bien al segundo intento.
    return parseVerdicts(await ask(prompt), jobs.length);
  }
};
