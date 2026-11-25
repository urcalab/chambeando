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

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Entidades HTML con nombre de uso común y todas las numéricas (&#xF3; &#243;). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? whole;
    const n = code[1]!.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  });
}

export function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<(br|\/p|\/li|\/h\d)\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))
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

export const COUNTRIES = {
  AR: "Argentina", BO: "Bolivia", CL: "Chile", CO: "Colombia", CR: "Costa Rica", DO: "República Dominicana",
  EC: "Ecuador", SV: "El Salvador", GT: "Guatemala", HN: "Honduras", MX: "México", NI: "Nicaragua",
  PA: "Panamá", PY: "Paraguay", PE: "Perú", UY: "Uruguay", VE: "Venezuela",
} as const;
export type Country = keyof typeof COUNTRIES;

/**
 * Países en que el servicio está abierto. Los conectores cubren más (todos los de COUNTRIES);
 * abrir otro es agregarlo a la variable COUNTRIES del entorno.
 */
export const ENABLED_COUNTRIES: Country[] = (process.env.COUNTRIES ?? "CL,MX,PE,CO")
  .split(",")
  .map((c) => c.trim().toUpperCase())
  .filter((c): c is Country => c in COUNTRIES);

export const isEnabled = (country: Country) => ENABLED_COUNTRIES.includes(country);

// Los prefijos más largos primero, para que +593 no se lea como +59x de otro país.
const PHONE_PREFIX: Array<[string, Country]> = [
  ["+1809", "DO"], ["+1829", "DO"], ["+1849", "DO"],
  ["+591", "BO"], ["+593", "EC"], ["+595", "PY"], ["+598", "UY"],
  ["+502", "GT"], ["+503", "SV"], ["+504", "HN"], ["+505", "NI"], ["+506", "CR"], ["+507", "PA"],
  ["+51", "PE"], ["+52", "MX"], ["+54", "AR"], ["+56", "CL"], ["+57", "CO"], ["+58", "VE"],
];

/** El país de un número de WhatsApp por su código, o null si no atendemos ese país. */
export function countryOfPhone(phone: string): Country | null {
  const country = PHONE_PREFIX.find(([prefix]) => phone.startsWith(prefix))?.[1];
  return country && isEnabled(country) ? country : null;
}

/** Acepta el código ("MX") o el nombre ("México", "mexico") de un país abierto. */
export function countryOf(text: string | null | undefined): Country | null {
  const t = normalize(text ?? "");
  if (!t) return null;
  for (const [code, name] of Object.entries(COUNTRIES)) {
    if (t === code.toLowerCase() || t === normalize(name)) return isEnabled(code as Country) ? (code as Country) : null;
  }
  return null;
}

/**
 * La región, provincia, estado o departamento de un lugar, en forma comparable.
 * Chile tiene claves fijas porque sus dos portales la escriben distinto; en el resto
 * es el texto después de la última coma, normalizado ("Canning, Buenos Aires" -> "buenos aires").
 */
export function regionOf(country: Country, location: string | null | undefined): string | null {
  if (!location) return null;
  if (country === "CL") return regionKey(location);
  // Computrabajo escribe "Bogotá, D.C.": la coma es parte del nombre del departamento.
  // Bumeran dice "Distrito Federal" y Computrabajo "Ciudad de México DF": una sola clave.
  if (country === "MX" && /\b(distrito federal|ciudad de mexico|cdmx|df)\b/.test(normalize(location.split(",").pop() ?? ""))) {
    return "ciudad de mexico";
  }
  if (country === "CO") return normalize(location.replace(/[,\s]\s*d\.?\s*c\.?\s*$/i, "")) || null;
  const parts = location.split(",");
  return normalize(parts[parts.length - 1] ?? "") || null;
}

/** Igual, o una contiene a la otra: "lima" calza con "lima metropolitana". */
export function regionMatches(wanted: string[], region: string): boolean {
  const r = ` ${region} `;
  return wanted.some((w) => w === region || r.includes(` ${w} `) || ` ${w} `.includes(r));
}

export const COUNTRY_TZ: Record<Country, string> = {
  AR: "America/Argentina/Buenos_Aires", BO: "America/La_Paz", CL: "America/Santiago", CO: "America/Bogota",
  CR: "America/Costa_Rica", DO: "America/Santo_Domingo", EC: "America/Guayaquil", SV: "America/El_Salvador",
  GT: "America/Guatemala", HN: "America/Tegucigalpa", MX: "America/Mexico_City", NI: "America/Managua",
  PA: "America/Panama", PY: "America/Asuncion", PE: "America/Lima", UY: "America/Montevideo", VE: "America/Caracas",
};

/** Fecha (YYYY-MM-DD) y hora local de un instante en el país. */
export function localNow(country: Country, at = new Date()): { date: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: COUNTRY_TZ[country], year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(at).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** "hoy", "ayer", "hace 3 días" o "el 12-11", a partir de la fecha en que el portal publicó el aviso. */
export function publishedAgo(publishedAt: string | null | undefined, country: Country, at = new Date()): string | null {
  const day = publishedAt?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!day) return null;
  const diff = Math.round((Date.parse(`${localNow(country, at).date}T00:00:00Z`) - Date.parse(`${day[0]}T00:00:00Z`)) / 86_400_000);
  if (diff <= 0) return "hoy";
  if (diff === 1) return "ayer";
  if (diff < 7) return `hace ${diff} días`;
  return `el ${day[3]}-${day[2]}`;
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

/** Las modalidades que le sirven a la persona: quien acepta ir a la oficina todos los días también acepta ir algunos. */
/** Regiones donde vale una modalidad, cuando no le sirve en todas las suyas. El remoto no tiene lugar. */
export type ModalityRegions = Partial<Record<"presencial" | "hibrido", string[]>>;

/**
 * Si la modalidad del aviso le sirve en la región del aviso. "Presencial en Talca o híbrido en Santiago" son dos
 * listas sueltas (regiones y modalidades) que por sí solas aceptan presencial en Santiago: `solo_en` lo cierra.
 * Lo que vale para presencial vale para híbrido si híbrido no tiene lista propia, porque `acceptedModalities`
 * lo suma solo cuando no lo pidió.
 */
export function modalityRegionOk(user: { modalities: Modality[]; modality_regions: ModalityRegions }, modality: Modality, region: string): boolean {
  if (modality === "remoto") return true;
  const own = user.modality_regions[modality];
  const inherited = modality === "hibrido" && !user.modalities.includes("hibrido") ? user.modality_regions.presencial : undefined;
  const allowed = own ?? inherited;
  return !allowed?.length || regionMatches(allowed, region);
}

export function acceptedModalities(modalities: Modality[]): Modality[] {
  return modalities.includes("presencial") && !modalities.includes("hibrido") ? [...modalities, "hibrido"] : modalities;
}

/**
 * Cada cuánto quiere los avisos automáticos: apenas aparezcan (con el mínimo entre mensajes), una vez al día o una
 * vez a la semana (los lunes), desde su hora.
 */
export const FREQUENCIES = ["apenas", "diaria", "semanal"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const JOB_KINDS = ["practica", "part_time", "full_time"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * Qué tipo de trabajo es un aviso, por lo que dice su jornada y su título. null si no se sabe.
 * El título manda para las prácticas: los portales suelen publicarlas como "Full-time".
 */
export function jobKind(jobType: string | null | undefined, title: string): JobKind | null {
  if (/\b(practica|practicante|pasantia|pasante|becario|becaria|trainee|intern|internship)\b/.test(normalize(`${title} ${jobType ?? ""}`))) {
    return "practica";
  }
  const t = normalize(jobType ?? "");
  if (/part time|medio tiempo|media jornada|por horas|tiempo parcial/.test(t)) return "part_time";
  if (/full time|jornada completa|tiempo completo/.test(t)) return "full_time";
  return null;
}

/** Teléfono solo con dígitos y un + adelante, para que el mismo número sea siempre la misma clave. */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}
