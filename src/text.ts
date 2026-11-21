/** Minúsculas, sin tildes ni signos: para comparar texto escrito de formas distintas. */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function slugify(s: string): string {
  return normalize(s).replace(/ /g, "-");
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(br|\/p|\/li|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n\s*/g, "\n")
    .trim();
}

/** Regiones de Chile: clave estable, numeral romano (Laborum) y nombres con que aparecen. */
const REGIONS: Array<{ key: string; roman: string; names: string[] }> = [
  { key: "arica", roman: "XV", names: ["arica"] },
  { key: "tarapaca", roman: "I", names: ["tarapaca", "iquique"] },
  { key: "antofagasta", roman: "II", names: ["antofagasta", "calama"] },
  { key: "atacama", roman: "III", names: ["atacama", "copiapo"] },
  { key: "coquimbo", roman: "IV", names: ["coquimbo", "la serena"] },
  { key: "valparaiso", roman: "V", names: ["valparaiso", "vina del mar"] },
  { key: "metropolitana", roman: "RM", names: ["metropolitana", "santiago"] },
  { key: "ohiggins", roman: "VI", names: ["o higgins", "ohiggins", "rancagua"] },
  { key: "maule", roman: "VII", names: ["maule", "talca"] },
  { key: "nuble", roman: "XVI", names: ["nuble", "chillan"] },
  { key: "biobio", roman: "VIII", names: ["biobio", "bio bio", "concepcion"] },
  { key: "araucania", roman: "IX", names: ["araucania", "temuco"] },
  { key: "los-rios", roman: "XIV", names: ["los rios", "valdivia"] },
  { key: "los-lagos", roman: "X", names: ["los lagos", "puerto montt"] },
  { key: "aysen", roman: "XI", names: ["aysen", "coyhaique"] },
  { key: "magallanes", roman: "XII", names: ["magallanes", "punta arenas"] },
];

export const REGION_KEYS = REGIONS.map((r) => r.key);

/**
 * La región de un texto como "Providencia, Región Metropolitana", "Región VII",
 * "Santiago, Metropolitana de Santiago" o "Biobío". null si no se reconoce.
 * Mira primero la parte después de la última coma, que es donde los portales ponen la región.
 */
export function regionKey(text: string | null | undefined): string | null {
  if (!text) return null;
  const parts = text.split(",");
  const tail = normalize(parts[parts.length - 1] ?? "");
  const roman = tail.match(/^region ([ivx]+)$/);
  if (roman) {
    const found = REGIONS.find((r) => r.roman.toLowerCase() === roman[1]);
    if (found) return found.key;
  }
  for (const candidate of [tail, normalize(text)]) {
    const padded = ` ${candidate} `;
    for (const r of REGIONS) {
      if (r.key === candidate) return r.key;
      if (r.names.some((n) => padded.includes(` ${n} `))) return r.key;
    }
  }
  return null;
}

export type Modality = "presencial" | "hibrido" | "remoto";

export function modalityOf(text: string | null | undefined): Modality | null {
  const t = normalize(text ?? "");
  if (!t) return null;
  if (t.includes("hibrid") || t.includes("mixta")) return "hibrido";
  if (t.includes("remot") || t.includes("teletrabajo")) return "remoto";
  if (t.includes("presencial")) return "presencial";
  return null;
}

/** Teléfono solo con dígitos y un + adelante, para que el mismo número sea siempre la misma clave. */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}
