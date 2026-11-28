import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../src/config.ts";
import { fromBlob, now, openDb, toBlob } from "../src/db.ts";
import { linkToken, recordClick, stats } from "../src/feedback.ts";
import { maskPhone, phoneId } from "../src/admin.ts";
import { createApp } from "../src/server.ts";
import type { AddressInfo } from "node:net";
import { companyKey, dedupeKey, ingest, localityOf, SAME_AD_WORDS, sameLocality, sharedWords } from "../src/ingest.ts";
import { newRegions, sources } from "../src/cycle.ts";
import type { Embedder } from "../src/embed.ts";
import { buildPrompt, parseVerdicts, type Judge } from "../src/llm.ts";
import { fillRoleVectors, matchAll, passesFilters, queriesOf, rank, STALE_PENALTY } from "../src/match.ts";
import { canMessageNow, formatMessage, notifyAll, salaryLine, templateTitle, type Replied, type Sender } from "../src/notify.ts";
import { computrabajo, parseListing, regionsFor, toJob as computrabajoJob } from "../src/sources/computrabajo.ts";
import { HttpError, retryable, withRetries } from "../src/sources/http.ts";
import { availableIn, getonboard, toJob as getonboardJob } from "../src/sources/getonboard.ts";
import { parseJobintDate, toJob as jobintJob } from "../src/sources/jobint.ts";
import { toJob as trabajandoJob } from "../src/sources/trabajando.ts";
import { bne, salaryOf, toJob as bneJob } from "../src/sources/bne.ts";
import { magneto, listingUrl as magnetoUrl, parsePage as magnetoPage, toJob as magnetoJob } from "../src/sources/magneto.ts";
import { chiletrabajos, listingUrl, parseListing as chiletrabajosListing, toJob as chiletrabajosJob } from "../src/sources/chiletrabajos.ts";
import type { NewJob } from "../src/sources/types.ts";
import type { JobKind, Modality } from "../src/text.ts";
import { createTools } from "../src/tools.ts";
import { countryOfPhone, jobKind, localNow, modalityOf, normalizePhone, publishedAgo, regionKey, regionOf } from "../src/text.ts";

test("regionKey reconoce los formatos de los dos portales", () => {
  assert.equal(regionKey("Providencia, Región Metropolitana"), "metropolitana");
  assert.equal(regionKey("Constitución, Región VII"), "maule");
  assert.equal(regionKey("Provincia de Antofagasta, Región II"), "antofagasta");
  assert.equal(regionKey("Santiago, Metropolitana de Santiago"), "metropolitana");
  assert.equal(regionKey("Rancagua, Lib. Gral. Bdo. O'Higgins"), "ohiggins");
  assert.equal(regionKey("Chillán, Ñuble"), "nuble");
  assert.equal(regionKey("Biobío"), "biobio");
  assert.equal(regionKey("los-rios"), "los-rios");
  assert.equal(regionKey("Madrid, Extranjero"), null);
  assert.equal(regionKey(null), null);
});

test("país por código del número y región fuera de Chile", () => {
  assert.equal(countryOfPhone("+56911112222"), "CL");
  assert.equal(countryOfPhone("+51987654321"), "PE");
  // Argentina tiene conector, pero el servicio todavía no está abierto ahí.
  assert.equal(countryOfPhone("+5491122223333"), null);
  assert.equal(countryOfPhone("+5215512345678"), "MX");
  assert.equal(countryOfPhone("+593991234567"), null);
  assert.equal(countryOfPhone("+5511912345678"), null);
  assert.equal(regionOf("PE", "Cercado De Lima, Lima"), "lima");
  assert.equal(regionOf("MX", "Churubusco, Distrito Federal"), "ciudad de mexico");
  assert.equal(regionOf("MX", "Ciudad de México DF"), "ciudad de mexico");
  assert.equal(regionOf("MX", "CDMX"), "ciudad de mexico");
  assert.equal(regionOf("MX", "Estado de México"), "estado de mexico");
  assert.equal(regionOf("CL", "Constitución, Región VII"), "maule");
});

test("jobKind lee la jornada de los tres portales y las prácticas por el título", () => {
  assert.equal(jobKind("Full-time", "Contador"), "full_time");
  assert.equal(jobKind("FULL_TIME", "Contador"), "full_time");
  assert.equal(jobKind("Jornada Completa", "Contador"), "full_time");
  assert.equal(jobKind("Part Time", "Vendedor"), "part_time");
  assert.equal(jobKind("Por Horas", "Vendedor"), "part_time");
  assert.equal(jobKind("Práctica", "Diseño"), "practica");
  assert.equal(jobKind("Full-time", "Practicante de Marketing"), "practica");
  assert.equal(jobKind("FULL_TIME", "Becario de sistemas"), "practica");
  assert.equal(jobKind(null, "Contador"), null);
  // "Buenas prácticas" en el título no lo convierte en una práctica.
  assert.equal(jobKind("Full-time", "Jefe de buenas practicas"), "full_time");
});

test("modalityOf", () => {
  assert.equal(modalityOf("Híbrido"), "hibrido");
  assert.equal(modalityOf("Mixta (Teletrabajo + Presencial)"), "hibrido");
  assert.equal(modalityOf("Teletrabajo"), "remoto");
  assert.equal(modalityOf("Jornada Completa"), null);
});

test("normalizePhone deja el mismo número con la misma clave", () => {
  assert.equal(normalizePhone("+56 9 1111 2222"), "+56911112222");
  assert.equal(normalizePhone("56911112222"), "+56911112222");
});

test("Laborum: convierte un aviso y descarta uno sin título", () => {
  assert.equal(parseJobintDate("20-11-2026 21:28:25"), "2026-11-20 21:28");
  const aviso = {
    id: 1118672242,
    titulo: "Técnico Educador Peluquería",
    detalle: "<p>Hola</p><p>Mundo</p>",
    empresa: "Confidencial",
    localizacion: "Providencia, Región Metropolitana",
    modalidadTrabajo: "Presencial",
    tipoTrabajo: "Full-time",
    fechaHoraPublicacion: "20-11-2026 21:28:25",
  };
  const job = jobintJob(aviso, "laborum");
  assert.equal(job?.id, "laborum:1118672242");
  assert.equal(job?.country, "CL");
  assert.equal(job?.url, "https://www.laborum.cl/empleos/tecnico-educador-peluqueria-1118672242.html");
  assert.equal(job?.company, null);
  assert.equal(job?.region, "metropolitana");
  assert.equal(job?.description, "Hola\nMundo");
  assert.equal(jobintJob({ id: 1 }, "laborum"), null);
  // El mismo formato en otro país: otro dominio, otro país y la provincia como región.
  const ar = jobintJob({ ...aviso, localizacion: "Canning, Buenos Aires" }, "bumeran-ar");
  assert.equal(ar?.id, "bumeran-ar:1118672242");
  assert.equal(ar?.country, "AR");
  assert.equal(ar?.source, "bumeran");
  assert.equal(ar?.region, "buenos aires");
  assert.match(ar!.url, /^https:\/\/www\.bumeran\.com\.ar\/empleos\//);
});

test("Trabajando: usa el detalle si viene y el listado si no", () => {
  const listed = {
    idOferta: 6152976,
    nombreCargo: "Analista de Cumplimiento",
    nombreEmpresa: "Fondo Esperanza",
    ubicacion: "Santiago, Metropolitana de Santiago",
    nombreJornada: "Jornada Completa",
    fechaPublicacion: "2026-11-20 22:27",
    descripcionOferta: "Extracto...",
  };
  const full = trabajandoJob(listed, {
    slug: "6152976-analista-de-cumplimiento",
    descripcionOferta: "<p>Completa</p>",
    mostrarSueldo: true,
    sueldo: 1100000,
    nombreJornada: "Mixta (Teletrabajo + Presencial)",
    ubicacion: { nombreRegion: "Metropolitana de Santiago", nombreComuna: "Santiago" },
  });
  assert.equal(full?.salary, 1100000);
  assert.equal(full?.modality, "hibrido");
  assert.equal(full?.description, "Completa");
  const bare = trabajandoJob(listed, null);
  assert.equal(bare?.url, "https://www.trabajando.cl/trabajo/6152976-analista-de-cumplimiento");
  assert.equal(bare?.description, "Extracto...");
  assert.equal(bare?.salary, null);
  // Sueldo oculto por la empresa: no se guarda.
  assert.equal(trabajandoJob(listed, { mostrarSueldo: false, sueldo: 5 })?.salary, null);
});

test("Computrabajo: lee el listado HTML y el JSON-LD del aviso", () => {
  const listing = `<div><article class="box_offer" data-id='74C2C0B04F7E027161373E686DCF3405' id="x">
    <h2><a class="js-o-link fc_base" href="/ofertas-de-trabajo/oferta-de-trabajo-de-asesor-74C2C0B04F7E027161373E686DCF3405#lc=ListOffers-Score-0">
      Asesor / Atenci&#xF3;n al cliente </a></h2></article><article class="otro"><p>sin enlace</p></article></div>`;
  const items = parseListing(listing);
  assert.deepEqual(items, [{
    id: "74C2C0B04F7E027161373E686DCF3405",
    path: "/ofertas-de-trabajo/oferta-de-trabajo-de-asesor-74C2C0B04F7E027161373E686DCF3405",
    title: "Asesor / Atención al cliente",
  }]);
  const detail = `<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
    <script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      description: "Funciones:<br/>Atenci&#243;n al cliente",
      datePosted: "2026-11-21",
      employmentType: "FULL_TIME",
      jobLocation: { address: { addressLocality: "Sincelejo", addressRegion: "Sincelejo" } },
      baseSalary: { value: { value: 3000000, unitText: "MONTH" } },
      hiringOrganization: { name: "ACTIVOS S A S" },
    })}</script>`;
  const job = computrabajoJob("computrabajo-co", "Sucre", items[0]!, detail);
  assert.equal(job?.id, "computrabajo-co:74C2C0B04F7E027161373E686DCF3405");
  assert.equal(job?.country, "CO");
  assert.equal(job?.region, "sucre");
  assert.equal(job?.location, "Sincelejo");
  assert.equal(job?.salary, 3000000);
  assert.equal(job?.description, "Funciones:\nAtención al cliente");
  assert.match(job!.url, /^https:\/\/co\.computrabajo\.com\/ofertas-de-trabajo\//);
  assert.equal(computrabajoJob("computrabajo-co", "Sucre", items[0]!, "<html>sin datos</html>"), null);
  // Sin JSON-LD, el aviso entra con lo que trae el HTML.
  const plain = `<h1>Asesor</h1><p class="fs16">Importante empresa del sector - Santa Marta, Magdalena</p>
    <div class="mb40" div-link="oferta"><div class="mbB"><span>A convenir</span></div><p class="mbB">Ruta de ventas.<br />Lunes a s&#xE1;bado</p></div>`;
  const fromHtml = computrabajoJob("computrabajo-co", "Magdalena", items[0]!, plain);
  assert.equal(fromHtml?.description, "Ruta de ventas.\nLunes a sábado");
  assert.equal(fromHtml?.company, null);
  assert.equal(fromHtml?.location, "Santa Marta, Magdalena");
  assert.equal(fromHtml?.region, "magdalena");
  // Un href con entidades no se corta en el "#" de la entidad.
  const odd = parseListing(`<article data-id='AAAAAAAAAAAAAAAA1234'><a class="js-o-link" href="/ofertas-de-trabajo/oferta-348807&#x2B;bogot&#xE1;-AAAA#lc=x">T</a></article>`);
  assert.equal(odd[0]?.path, "/ofertas-de-trabajo/oferta-348807+bogot%C3%A1-AAAA");
  assert.equal(computrabajoJob("computrabajo-co", "Bogotá, D.C.", items[0]!, detail)?.region, "bogota");
  // En Chile la región de Computrabajo cae en la misma clave que la de Laborum y Trabajando.
  assert.equal(computrabajoJob("computrabajo-cl", "R.Metropolitana", items[0]!, detail)?.region, "metropolitana");
  assert.equal(computrabajoJob("computrabajo-mx", "Nuevo León", items[0]!, detail)?.region, "nuevo leon");
  assert.equal(regionOf("CO", "Bogotá, D.C."), "bogota");
  assert.equal(countryOfPhone("+573001234567"), "CO");
});

test("passesFilters solo descarta por lo que el aviso dice", () => {
  const user = { regions: ["metropolitana"], modalities: [], modality_regions: {}, min_salary: 900000, exclude: ["call center"], job_kinds: [] as JobKind[] };
  const job = { title: "Contador", region: "metropolitana", modality: null, salary: null, job_type: null as string | null };
  assert.equal(passesFilters(user, job), true);
  assert.equal(passesFilters(user, { ...job, region: "biobio" }), false);
  assert.equal(passesFilters(user, { ...job, region: "biobio", modality: "remoto" }), true);
  assert.equal(passesFilters(user, { ...job, region: null }), true);
  assert.equal(passesFilters(user, { ...job, salary: 600000 }), false);
  assert.equal(passesFilters(user, { ...job, title: "Ejecutivo Call Center" }), false);
  assert.equal(passesFilters({ ...user, modalities: ["remoto"] }, { ...job, modality: "presencial" }), false);
  // Presencial incluye híbrido; solo remoto no.
  assert.equal(passesFilters({ ...user, modalities: ["presencial", "remoto"] }, { ...job, modality: "hibrido" }), true);
  assert.equal(passesFilters({ ...user, modalities: ["remoto"] }, { ...job, modality: "hibrido" }), false);
  // Tipo de trabajo: quien busca práctica no recibe empleos de jornada completa, y al revés.
  const intern = { ...user, job_kinds: ["practica"] as JobKind[] };
  assert.equal(passesFilters(intern, { ...job, job_type: "Full-time" }), false);
  assert.equal(passesFilters(intern, { ...job, title: "Práctica contabilidad", job_type: "Full-time" }), true);
  assert.equal(passesFilters(intern, job), true);
  assert.equal(passesFilters({ ...user, job_kinds: ["full_time", "part_time"] }, { ...job, title: "Practicante de finanzas" }), false);
});

test("solo_en: presencial en Talca, híbrido en Santiago o remoto", async () => {
  // Felipe pidió eso y le llegó un aviso presencial en Providencia (chambeando, 2026-11-24).
  const felipe = {
    regions: ["maule", "metropolitana"], modalities: ["presencial", "hibrido", "remoto"] as Modality[],
    modality_regions: { presencial: ["maule"] }, min_salary: null, exclude: [], job_kinds: [] as JobKind[],
  };
  const job = { title: "Jefe de marketing", region: "metropolitana", modality: "presencial" as Modality | null, salary: null, job_type: null };
  assert.equal(passesFilters(felipe, job), false);
  assert.equal(passesFilters(felipe, { ...job, region: "maule" }), true);
  assert.equal(passesFilters(felipe, { ...job, modality: "hibrido" }), true);
  assert.equal(passesFilters(felipe, { ...job, region: "biobio", modality: "remoto" }), true);
  // Sin modalidad informada no se descarta.
  assert.equal(passesFilters(felipe, { ...job, modality: null }), true);
  // Si no pidió híbrido aparte, el híbrido sigue al presencial.
  const onSite = { ...felipe, modalities: ["presencial", "remoto"] as Modality[] };
  assert.equal(passesFilters(onSite, { ...job, modality: "hibrido" }), false);
  assert.equal(passesFilters(onSite, { ...job, region: "maule", modality: "hibrido" }), true);

  // Por la herramienta: guarda la región como clave, la suma a sus regiones y se conserva si no viene.
  const db = openDb(":memory:");
  const tools = createTools(db, fakeEmbed, null);
  const phone = "+56977778888";
  const saved = await tools.guardar_preferencias({
    phone, resumen: "jefe de marketing", regiones: ["Región Metropolitana"],
    modalidades: ["presencial", "hibrido", "remoto"], solo_en: { presencial: ["Maule"] },
  });
  assert.deepEqual(saved.preferencias.solo_en, { presencial: ["maule"] });
  assert.deepEqual(saved.preferencias.regiones.sort(), ["maule", "metropolitana"]);
  await tools.guardar_preferencias({ phone, cargos: ["jefe de marketing"] });
  assert.deepEqual((await tools.ver_perfil({ phone })).preferencias.solo_en, { presencial: ["maule"] });
  // Una lista vacía la quita.
  await tools.guardar_preferencias({ phone, solo_en: { presencial: [] } });
  assert.deepEqual((await tools.ver_perfil({ phone })).preferencias.solo_en, {});
});

test("parseVerdicts tolera texto alrededor del JSON y avisos que faltan", () => {
  const v = parseVerdicts('Claro:\n```json\n{"avisos":[{"n":2,"sirve":true,"motivo":"calza"}]}\n```', 3);
  assert.deepEqual(v.map((x) => x.ok), [false, true, false]);
  assert.throws(() => parseVerdicts("no sé", 1));
});

// Embeddings de mentira: un eje por palabra clave, para que el orden sea predecible.
const AXES = ["contador", "enfermera", "vendedor"];
const fakeEmbed: Embedder = async (texts) =>
  texts.map((t) => {
    const v = new Float32Array(AXES.map((a) => (t.toLowerCase().includes(a) ? 1 : 0.01)));
    const norm = Math.hypot(...v);
    return v.map((x) => x / norm);
  });

async function addJob(db: ReturnType<typeof openDb>, over: Partial<NewJob> & { id: string; title: string }, seenAt = now()) {
  const country = over.country ?? "CL";
  const [vec] = await fakeEmbed([over.title], "passage");
  db.prepare(
    `INSERT INTO jobs (id, source, source_id, country, url, title, company, location, region, modality, job_type, salary,
                       description, published_at, first_seen_at, embedding)
     VALUES (?, 'laborum', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', NULL, ?, ?)`,
  ).run(
    over.id, over.id, country, `https://x/${over.id}`, over.title, over.company ?? null, over.location ?? null,
    over.region === undefined ? (country === "CL" ? "metropolitana" : null) : over.region, over.modality ?? null, over.job_type ?? null, over.salary ?? null, seenAt, toBlob(vec!),
  );
}

const approveAll: Judge = async (_u, _p, jobs) => jobs.map(() => ({ ok: true, reason: "" }));

test("se busca con un vector por cargo, y con el del perfil entero solo si no dijo cargos", async () => {
  const db = openDb(":memory:");
  await addJob(db, { id: "c", title: "Contador general" });
  await addJob(db, { id: "v", title: "Vendedor de tienda" });
  await addJob(db, { id: "e", title: "Enfermera de turno" });
  const tools = createTools(db, fakeEmbed, null);
  const phone = "+56911110010";
  // El resumen nombra los tres rubros: el vector del perfil entero queda a la misma distancia de los tres avisos.
  await tools.guardar_preferencias({ phone, resumen: "contador, vendedor o enfermera, lo que salga", cargos: ["contador", "vendedor"] });
  const row = db.prepare("SELECT embedding, role_embeddings FROM users WHERE phone = ?").get(phone) as any;
  const queries = queriesOf(row);
  assert.equal(queries.length, 2);
  const user = (await import("../src/db.ts")).getUser(db, phone)!;
  // Con un vector por cargo, los dos avisos de sus cargos le ganan al que solo nombra el resumen.
  assert.deepEqual(rank(db, user, queries, { limit: 2, skipStatuses: [] }).map((s) => s.job.id).sort(), ["c", "v"]);
  assert.ok(rank(db, user, queries, { limit: 3, skipStatuses: [] })[0]!.score > 0.99);
  // Con el perfil entero, los tres empatan.
  const flat = rank(db, user, [fromBlob(row.embedding)], { limit: 3, skipStatuses: [] }).map((s) => s.score);
  assert.ok(Math.max(...flat) - Math.min(...flat) < 1e-6);

  // Un perfil guardado antes de que existieran los vectores por cargo los recibe en la corrida; uno sin cargos no
  // tiene nada que calcular y se busca solo con el perfil entero.
  db.prepare("UPDATE users SET role_embeddings = NULL").run();
  await tools.guardar_preferencias({ phone: "+56911110011", resumen: "busco de vendedor" });
  db.prepare("UPDATE users SET role_embeddings = NULL WHERE phone = ?").run("+56911110011");
  assert.equal(await fillRoleVectors(db, fakeEmbed), 1);
  assert.equal(queriesOf(db.prepare("SELECT embedding, role_embeddings FROM users WHERE phone = ?").get(phone) as any).length, 2);
  assert.equal(queriesOf(db.prepare("SELECT embedding, role_embeddings FROM users WHERE phone = ?").get("+56911110011") as any).length, 1);
  assert.equal(await fillRoleVectors(db, fakeEmbed), 0);
});

test("un aviso de hace más de 3 meses pierde frente a uno reciente igual de parecido", async () => {
  const db = openDb(":memory:");
  await addJob(db, { id: "viejo", title: "Contador general", company: "A" });
  await addJob(db, { id: "nuevo", title: "Contador general", company: "B" });
  const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
  db.prepare("UPDATE jobs SET published_at = ? WHERE id = 'viejo'").run(day(200));
  db.prepare("UPDATE jobs SET published_at = ? WHERE id = 'nuevo'").run(day(0));
  const tools = createTools(db, fakeEmbed, null);
  const phone = "+56911110012";
  await tools.guardar_preferencias({ phone, resumen: "contador", cargos: ["contador"] });
  const user = (await import("../src/db.ts")).getUser(db, phone)!;
  const queries = queriesOf(db.prepare("SELECT embedding, role_embeddings FROM users WHERE phone = ?").get(phone) as any);
  const [first, second] = rank(db, user, queries, { limit: 2, skipStatuses: [] });
  assert.equal(first!.job.id, "nuevo");
  assert.ok(Math.abs(first!.score - second!.score - STALE_PENALTY) < 1e-6);
});

test("el juez sabe cuándo solo le sirve remoto, y la plantilla corta el cargo donde termina una parte", () => {
  const user = {
    country: "CL", summary: "ventas", studies: null, first_job: null, job_kinds: [], roles: [], regions: [],
    modalities: ["remoto"], modality_regions: {}, min_salary: null, exclude: [],
  } as any;
  assert.match(buildPrompt(user, [], []), /Modalidad: solo remoto/);
  assert.match(buildPrompt(user, [], []), /salvo si solo le sirve remoto/);
  assert.doesNotMatch(buildPrompt({ ...user, modalities: ["presencial", "remoto"] }, [], []), /solo remoto/);
  assert.equal(
    templateTitle("Software Engineer Full Stack (.NET Core / React)  para empresa Retail en Las Condes"),
    "Software Engineer Full Stack (.NET Core / React) para empresa Retail",
  );
  assert.equal(templateTitle("Analista de Gestión Documental y Procedimientos Jr."), "Analista de Gestión Documental y Procedimientos Jr");
  assert.equal(templateTitle("Ingeniero de Software ".repeat(6)).length <= 81, true);
});

test("lo que sale al buscar guarda por qué: el motivo del modelo, o que salió sin revisión", async () => {
  const db = openDb(":memory:");
  await addJob(db, { id: "a", title: "Contador general" });
  const reasonOf = (phone: string) =>
    (db.prepare("SELECT reason, score FROM deliveries WHERE phone = ? AND job_id = 'a'").get(phone) as { reason: string; score: number | null });

  const judged = createTools(db, fakeEmbed, async (_u, _p, jobs) => jobs.map(() => ({ ok: true, reason: "calza con contador" })));
  await judged.guardar_preferencias({ phone: "+56911110001", resumen: "busco de contador" });
  assert.equal(reasonOf("+56911110001").reason, "calza con contador");
  assert.ok(reasonOf("+56911110001").score !== null);

  const broken = createTools(db, fakeEmbed, async () => {
    throw new Error("se cayó");
  });
  const saved = await broken.guardar_preferencias({ phone: "+56911110002", resumen: "busco de contador" });
  assert.deepEqual(saved.avisos.map((a) => a.id), ["a"]);
  assert.equal(reasonOf("+56911110002").reason, "sin revisión: el modelo falló");

  await createTools(db, fakeEmbed, null).guardar_preferencias({ phone: "+56911110003", resumen: "busco de contador" });
  assert.equal(reasonOf("+56911110003").reason, "sin revisión: no hay modelo");
});

test("flujo completo: registro, match de avisos nuevos, envío, opinión y borrado", async () => {
  const db = openDb(":memory:");
  await addJob(db, { id: "a", title: "Contador general" });
  await addJob(db, { id: "b", title: "Enfermera clínica" });
  await addJob(db, { id: "c", title: "Contador senior", region: "biobio" });
  const tools = createTools(db, fakeEmbed, async (_u, _p, jobs) =>
    jobs.map((j) => ({ ok: j.title.includes("Contador"), reason: "" })),
  );
  const phone = "+56911112222";

  await assert.rejects(tools.buscar_avisos({ phone }), /todavía no ha dicho/);

  const saved = await tools.guardar_preferencias({ phone, resumen: "busco de contador", regiones: ["Región Metropolitana"] });
  assert.equal(saved.nuevo, true);
  assert.deepEqual(saved.preferencias.regiones, ["metropolitana"]);
  // Solo el contador de la RM: el de Biobío cae por región y la enfermera por el modelo.
  assert.deepEqual(saved.avisos.map((a) => a.id), ["a"]);

  const perfil = await tools.ver_perfil({ phone });
  assert.equal(perfil.preferencias.resumen, "busco de contador");
  assert.deepEqual(perfil.preferencias.regiones, ["metropolitana"]);
  assert.equal(perfil.avisos_automaticos, "activos");
  assert.equal(perfil.avisos_enviados, 1);
  await assert.rejects(tools.ver_perfil({ phone: "+56900000077" }), /todavía no ha dicho/);

  // Actualizar un campo conserva los demás.
  const updated = await tools.guardar_preferencias({ phone, sueldo_minimo: 800000 });
  assert.equal(updated.nuevo, false);
  assert.equal(updated.preferencias.resumen, "busco de contador");
  assert.deepEqual(updated.avisos, []);

  // Llegan avisos nuevos: uno calza, otro paga menos del mínimo, otro es de otra profesión.
  await new Promise((r) => setTimeout(r, 5));
  await addJob(db, { id: "d", title: "Contador tributario" });
  await addJob(db, { id: "e", title: "Contador junior", salary: 500000 });
  await addJob(db, { id: "f", title: "Vendedor de tienda" });
  const judged: string[] = [];
  const judge: Judge = async (_u, _p, jobs) =>
    jobs.map((j) => {
      judged.push(j.id);
      return { ok: j.title.includes("Contador"), reason: "calza" };
    });
  const matched = await matchAll(db, judge);
  assert.equal(matched.pending, 1);
  assert.deepEqual(judged.sort(), ["d", "f"]);
  // Una segunda corrida sin avisos nuevos no vuelve a evaluar nada.
  judged.length = 0;
  assert.equal((await matchAll(db, judge)).pending, 0);
  assert.deepEqual(judged, []);

  // Ventana abierta: va como texto y queda enviado.
  const sentTexts: string[] = [];
  const open: Sender = async (m) => {
    sentTexts.push(m.text);
    return { status: 202, mode: "text" };
  };
  const n1 = await notifyAll(db, open, { ignoreSchedule: true });
  assert.equal(n1.sent, 1);
  assert.match(sentTexts[0]!, /Contador tributario/);
  assert.equal((await notifyAll(db, open, { ignoreSchedule: true })).sent, 0);

  await tools.registrar_opinion({ phone, aviso_id: "d", util: false, motivo: "piden inglés" });
  await assert.rejects(tools.registrar_opinion({ phone, aviso_id: "zzz", util: true }), /No le hemos mandado/);

  // Ventana cerrada: va la plantilla y el aviso sigue pendiente hasta que la persona responde.
  await new Promise((r) => setTimeout(r, 5));
  await addJob(db, { id: "g", title: "Contador de costos" });
  await matchAll(db, approveAll);
  const calls: Array<{ template: boolean }> = [];
  const closed: Sender = async (m) => {
    calls.push({ template: Boolean(m.template) });
    return m.template ? { status: 202, mode: "template" } : { status: 422, code: "outside_window" };
  };
  assert.equal((await notifyAll(db, closed, { ignoreSchedule: true })).template, 1);
  assert.deepEqual(calls, [{ template: false }, { template: true }]);
  const pending = await tools.avisos_pendientes({ phone });
  assert.deepEqual(pending.avisos.map((a) => a.id), ["g"]);
  assert.deepEqual((await tools.avisos_pendientes({ phone })).avisos, []);

  // En pausa no se evalúa ni se manda nada.
  await tools.pausar_avisos({ phone, pausar: true });
  await new Promise((r) => setTimeout(r, 5));
  await addJob(db, { id: "h", title: "Contador auditor" });
  assert.equal((await matchAll(db, approveAll)).users, 0);

  assert.deepEqual(await tools.borrar_mis_datos({ phone }), { borrado: true });
  const left = db.prepare("SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM deliveries) AS n").get() as { n: number };
  assert.equal(left.n, 0);
});

test("un aviso republicado con otro id se muestra una sola vez", async () => {
  const db = openDb(":memory:");
  await addJob(db, { id: "r1", title: "Vendedor - Osorno", company: "Acme", location: "Osorno" });
  await addJob(db, { id: "r2", title: "Vendedor - Osorno", company: "Acme", location: "Osorno" });
  await addJob(db, { id: "r3", title: "Vendedor - Osorno", company: "Otra", location: "Osorno" });
  const tools = createTools(db, fakeEmbed, null);
  const saved = await tools.guardar_preferencias({ phone: "+56900000009", resumen: "vendedor" });
  assert.equal(saved.avisos.length, 2);
});

test("cada persona solo recibe avisos de su país", async () => {
  const db = openDb(":memory:");
  await addJob(db, { id: "cl", title: "Vendedor Santiago" });
  await addJob(db, { id: "pe1", title: "Vendedor Miraflores", country: "PE", region: "lima" });
  await addJob(db, { id: "pe2", title: "Vendedor Trujillo", country: "PE", region: "la libertad" });
  const tools = createTools(db, fakeEmbed, null);
  const pe = await tools.guardar_preferencias({ phone: "+51987654321", resumen: "vendedor", regiones: ["Lima"] });
  assert.equal(pe.preferencias.pais, "Perú");
  assert.deepEqual(pe.avisos.map((a) => a.id), ["pe1"]);
  // Un país con conector pero sin abrir: ni por número ni pidiéndolo.
  await assert.rejects(tools.guardar_preferencias({ phone: "+5491122223333", resumen: "vendedor" }), /Países disponibles: Chile, México, Perú, Colombia/);
  await assert.rejects(tools.guardar_preferencias({ phone: "+56911110000", resumen: "vendedor", pais: "Argentina" }), /Todavía no tenemos avisos/);
  // Un número de un país que no atendemos necesita decir dónde busca.
  await assert.rejects(tools.guardar_preferencias({ phone: "+5511912345678", resumen: "vendedor" }), /Países disponibles/);
  const co = await tools.guardar_preferencias({ phone: "+5511912345678", resumen: "vendedor", pais: "Chile" });
  assert.deepEqual(co.avisos.map((a) => a.id), ["cl"]);
});

test("perfil: primer trabajo, estudios y tipo de trabajo se guardan y filtran", async () => {
  const db = openDb(":memory:");
  await addJob(db, { id: "p1", title: "Práctica vendedor tienda" });
  await addJob(db, { id: "f1", title: "Vendedor senior", job_type: "Full-time" });
  let seen: any = null;
  const tools = createTools(db, fakeEmbed, async (u, _p, jobs) => {
    seen = u;
    return jobs.map(() => ({ ok: true, reason: "" }));
  });
  const phone = "+56922223333";
  const saved = await tools.guardar_preferencias({
    phone, resumen: "quiero trabajar de vendedor", estudios: "Técnico en administración, último año",
    primer_trabajo: true, tipos: ["practica"],
  });
  assert.deepEqual(saved.avisos.map((a) => a.id), ["p1"]);
  assert.equal(saved.preferencias.primer_trabajo, true);
  assert.deepEqual(saved.preferencias.tipos, ["practica"]);
  assert.equal(seen.first_job, true);
  assert.equal(seen.studies, "Técnico en administración, último año");
  // Cambiar solo el tipo conserva lo demás y abre los avisos de jornada completa.
  const wider = await tools.guardar_preferencias({ phone, tipos: ["practica", "full_time"] });
  assert.equal(wider.preferencias.estudios, "Técnico en administración, último año");
  assert.deepEqual(wider.avisos.map((a) => a.id), ["f1"]);
  await assert.rejects(tools.guardar_preferencias({ phone, tipos: ["freelance"] }));
});

test("buscar avisos es la búsqueda del perfil, y sin avisos nuevos desde la última no se repite", async () => {
  const db = openDb(":memory:");
  await addJob(db, { id: "a", title: "Contador general" });
  await addJob(db, { id: "b", title: "Técnicos en Enfermería UPC" });
  let judged: string[] = [];
  const tools = createTools(db, fakeEmbed, async (u, _p, jobs) => {
    judged.push(...jobs.map((j) => j.id));
    return jobs.map((j) => ({ ok: j.title.includes("Contador"), reason: "" }));
  });
  const phone = "+56933334444";
  const saved = await tools.guardar_preferencias({ phone, resumen: "busco de contador" });
  assert.deepEqual(saved.avisos.map((a) => a.id), ["a"]);

  // Guardar el perfil ya buscó y no llegó nada desde entonces: se dice así, sin buscar ni evaluar de nuevo.
  judged = [];
  assert.deepEqual(await tools.buscar_avisos({ phone }), { avisos: [], sin_novedades: true });
  assert.deepEqual(judged, []);

  // Llegan avisos nuevos: se busca con el perfil y el modelo deja solo lo que le sirve. Una consulta propia ya no
  // existe y se ignora: con ella, a una psicóloga que buscó "psicóloga clínica" le llegó un técnico en enfermería.
  await new Promise((r) => setTimeout(r, 5));
  await addJob(db, { id: "c", title: "Contador tributario" });
  await addJob(db, { id: "d", title: "Enfermera clínica" });
  const found = await tools.buscar_avisos({ phone, consulta: "enfermera", region: "Biobío" });
  assert.deepEqual(found.avisos.map((a) => a.id), ["c"]);
  assert.equal(found.sin_novedades, false);
  assert.deepEqual(judged.sort(), ["c", "d"]);
  assert.equal((await tools.buscar_avisos({ phone })).sin_novedades, true);

  // Lo que el match dejó listo y todavía no se mandó también cuenta como novedad.
  db.prepare("UPDATE deliveries SET status = 'pending' WHERE phone = ? AND job_id = 'c'").run(phone);
  const pending = await tools.buscar_avisos({ phone });
  assert.deepEqual(pending.avisos.map((a) => a.id), ["c"]);
});

test("duplicados: el mismo aviso en dos portales o republicado se guarda una vez como original", async () => {
  const base = {
    source: "bumeran", country: "PE" as const, url: "https://x", location: "Miraflores, Lima", region: "lima",
    modality: null, job_type: "Full-time", salary: null, published_at: null,
  };
  const a = { ...base, id: "bumeran-pe:1", source_id: "1", title: "Analista Contable", company: "Activos S.A.C.", description: "Texto A" };
  // Otro portal: otro id, la empresa escrita distinto, el lugar en otro orden.
  const b = { ...base, id: "computrabajo-pe:9", source_id: "9", source: "computrabajo", title: "ANALISTA CONTABLE", company: "ACTIVOS S A C", location: "Lima, Miraflores", description: "Texto B" };
  const other = { ...base, id: "bumeran-pe:2", source_id: "2", title: "Analista Contable", company: "Otra Empresa", description: "Texto C" };
  const arequipa = { ...base, id: "bumeran-pe:3", source_id: "3", title: "Analista Contable", company: "Activos S.A.C.", region: "arequipa", description: "Texto D" };
  // Confidenciales: mismo título, pero solo son el mismo aviso si el texto coincide.
  const conf1 = { ...base, id: "bumeran-pe:4", source_id: "4", title: "Vendedor", company: null, description: "Buscamos vendedor para tienda de ropa" };
  const conf2 = { ...base, id: "computrabajo-pe:5", source_id: "5", title: "Vendedor", company: null, description: "Buscamos vendedor para tienda de ropa" };
  const conf3 = { ...base, id: "bumeran-pe:6", source_id: "6", title: "Vendedor", company: null, description: "Ferretería requiere vendedor de mostrador" };
  assert.equal(dedupeKey(a), dedupeKey(b));
  assert.notEqual(dedupeKey(a), dedupeKey(other));
  assert.notEqual(dedupeKey(a), dedupeKey(arequipa));
  assert.equal(dedupeKey(conf1), dedupeKey(conf2));
  assert.notEqual(dedupeKey(conf1), dedupeKey(conf3));

  // La misma vacante en otra tienda de la misma región no es un duplicado.
  const surco = { ...a, id: "bumeran-pe:10", source_id: "10", location: "Santiago de Surco, Lima" };
  assert.equal(dedupeKey(a), dedupeKey(surco));
  assert.deepEqual(localityOf(a), ["miraflores"]);
  assert.deepEqual(localityOf(b), ["miraflores"]);
  assert.equal(sameLocality(localityOf(a), localityOf(surco)), false);
  assert.deepEqual(localityOf({ location: "R.Metropolitana, Santiago - Maipú", region: "metropolitana" }), ["maipu", "santiago"]);
  assert.equal(sameLocality(["maipu"], ["maipu", "santiago"]), true);
  assert.equal(sameLocality(["maipu"], []), true);

  const db = openDb(":memory:");
  const source = (jobs: NewJob[]) => async () => ({ jobs, pages: 1, invalid: 0 });
  const first = await ingest(db, fakeEmbed, { "bumeran-pe": { source: source([a, other, arequipa, conf1, conf3, surco]), maxPages: 1 } });
  assert.deepEqual([first["bumeran-pe"]!.added, first["bumeran-pe"]!.duplicates], [6, 0]);
  // Una corrida posterior de otro portal trae dos repetidos y, además, el mismo aviso dos veces en su propio lote.
  const fresh = { ...base, id: "computrabajo-pe:7", source_id: "7", source: "computrabajo", title: "Diseñador", company: "Estudio", description: "x" };
  const freshAgain = { ...fresh, id: "computrabajo-pe:8", source_id: "8" };
  const second = await ingest(db, fakeEmbed, { "computrabajo-pe": { source: source([b, conf2, fresh, freshAgain]), maxPages: 1 } });
  assert.deepEqual([second["computrabajo-pe"]!.added, second["computrabajo-pe"]!.duplicates], [1, 3]);
  const dup = db.prepare("SELECT duplicate_of, embedding FROM jobs WHERE id = ?").get("computrabajo-pe:9") as any;
  assert.equal(dup.duplicate_of, "bumeran-pe:1");
  assert.equal(dup.embedding, null);

  // A la persona le llega una sola vez, aunque el duplicado haya llegado después de su registro.
  const tools = createTools(db, fakeEmbed, null);
  const saved = await tools.guardar_preferencias({ phone: "+51987000111", resumen: "contador analista" });
  const ids = saved.avisos.map((x) => x.id);
  assert.ok(ids.includes("bumeran-pe:1"));
  assert.ok(!ids.includes("computrabajo-pe:9"));
  assert.equal(new Set(ids).size, ids.length);

  // Un portal dice la empresa y otro no (o la deja confidencial), y cada uno da el lugar a su manera: es el mismo
  // aviso si la descripción es en buena parte la misma. Con otra descripción, son dos avisos.
  const text = "Buscamos asesor comercial para desarrollo de negocios en el sector salud, con cartera de clientes y metas mensuales.";
  const withCo = { ...base, id: "bumeran-pe:20", source_id: "20", title: "Asesor Comercial - Sector Salud", company: "PeopleGo", location: "San Isidro, Lima", description: text };
  const noCo = { ...withCo, id: "computrabajo-pe:21", source_id: "21", source: "computrabajo", company: null, location: "Lima", description: `${text} Postula aquí.` };
  const confCo = { ...noCo, id: "computrabajo-pe:22", source_id: "22", company: "Empresa Confidencial", location: "Miraflores, Lima" };
  const otherAd = { ...noCo, id: "computrabajo-pe:23", source_id: "23", description: "Clínica requiere asesor para venta de planes de salud en sucursal, turnos rotativos." };
  assert.equal(companyKey("Empresa Confidencial"), "");
  await ingest(db, fakeEmbed, { "bumeran-pe": { source: source([withCo]), maxPages: 1 } });
  const third = await ingest(db, fakeEmbed, { "computrabajo-pe": { source: source([noCo, confCo, otherAd]), maxPages: 1 } });
  assert.deepEqual([third["computrabajo-pe"]!.added, third["computrabajo-pe"]!.duplicates], [1, 2]);
  const dupOf = (id: string) => (db.prepare("SELECT duplicate_of FROM jobs WHERE id = ?").get(id) as any).duplicate_of;
  assert.equal(dupOf("computrabajo-pe:21"), "bumeran-pe:20");
  assert.equal(dupOf("computrabajo-pe:22"), "bumeran-pe:20");
  assert.equal(dupOf("computrabajo-pe:23"), null);
  assert.ok(sharedWords(text, otherAd.description) < SAME_AD_WORDS);
});

test("feedback: links con token cuentan clics, y la opinión y la postulación llegan a las métricas", async () => {
  config.publicUrl = "https://chambeando.test";
  try {
    const db = openDb(":memory:");
    await addJob(db, { id: "a", title: "Contador general" });
    await addJob(db, { id: "b", title: "Contador junior" });
    const tools = createTools(db, fakeEmbed, null);
    const phone = "+56933334444";
    const saved = await tools.guardar_preferencias({ phone, resumen: "contador" });
    const link = saved.avisos[0]!.url;
    assert.match(link, /^https:\/\/chambeando\.test\/r\/[a-z2-9]{10}$/);
    assert.ok(!link.includes("56933334444"));
    const token = link.split("/r/")[1]!;
    assert.equal(token, linkToken(phone, saved.avisos[0]!.id));

    // El clic redirige al aviso original y queda contado.
    assert.equal(recordClick(db, token), `https://x/${saved.avisos[0]!.id}`);
    recordClick(db, token);
    assert.equal(recordClick(db, "noexiste1234"), null);
    // Mayúsculas o un link cortado (6+ caracteres) siguen llevando al aviso; un comienzo demasiado corto, no.
    assert.equal(recordClick(db, token.toUpperCase()), `https://x/${saved.avisos[0]!.id}`);
    assert.equal(recordClick(db, token.slice(0, 7)), `https://x/${saved.avisos[0]!.id}`);
    assert.equal(recordClick(db, token.slice(0, 4)), null);

    // El agente puede mandar el código del link o el link entero en vez del id interno.
    assert.deepEqual(await tools.registrar_opinion({ phone, aviso_id: token, util: true }), { registrado: true });
    assert.deepEqual(await tools.registrar_opinion({ phone, aviso_id: link, util: true }), { registrado: true });
    await assert.rejects(tools.registrar_opinion({ phone, aviso_id: "zzzzzzzz", util: true }), /No le hemos mandado/);
    // Un pedazo del título vale si calza con uno solo de los que recibió ("ID 1420 SERPAJ…" llegó como "1420").
    await assert.rejects(tools.registrar_opinion({ phone, aviso_id: "Contador", util: false }), /No le hemos mandado/);
    assert.deepEqual(await tools.registrar_opinion({ phone, aviso_id: "junior", util: false }), { registrado: true });
    await tools.registrar_opinion({ phone, aviso_id: saved.avisos[0]!.id, util: true, postulo: true });
    // Vatio no manda `util: false` en el body: si no viene, no le sirvió.
    await tools.registrar_opinion({ phone, aviso_id: saved.avisos[1]!.id, motivo: "pedían inglés" });
    const s = stats(db, 7);
    assert.equal(s.funnel.sent, 2);
    assert.equal(s.funnel.clicked, 1); // un aviso abierto, aunque con varios clics
    assert.equal(s.funnel.click_pct, 50);
    assert.equal(s.funnel.useful_pct, 50);
    assert.equal(s.funnel.applied, 1);
    assert.deepEqual(s.complaints.map((c) => ({ ...c })), [{ title: saved.avisos[1]!.cargo, feedback: "pedían inglés" }]);
    // Sin `motivo`, una segunda opinión no borra el que ya estaba.
    await tools.registrar_opinion({ phone, aviso_id: saved.avisos[1]!.id, util: false });
    assert.equal(stats(db, 7).complaints.length, 1);
  } finally {
    config.publicUrl = "";
  }
});

test("una base de la versión anterior recibe las columnas nuevas al abrirse", () => {
  const path = join(mkdtempSync(join(tmpdir(), "chambeando-")), "old.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE deliveries (phone TEXT NOT NULL, job_id TEXT NOT NULL, score REAL, reason TEXT, status TEXT NOT NULL,
    useful INTEGER, feedback TEXT, created_at TEXT NOT NULL, sent_at TEXT, PRIMARY KEY (phone, job_id))`);
  old.close();
  const db = openDb(path);
  const cols = (db.prepare("PRAGMA table_info(deliveries)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const c of ["applied", "token", "clicks", "first_click_at"]) assert.ok(cols.includes(c), c);
});

test("consola de admin: su propia clave, solo lee y edita preferencias, sin teléfonos, y cada llamada queda registrada", async () => {
  const db = openDb(":memory:");
  await addJob(db, { id: "a", title: "Contador general" });
  const server = createApp(db, fakeEmbed, "clave-backend", null, "clave-admin").listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, key: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  try {
    const phone = "+56948454110";
    assert.equal((await call("/tools/guardar_preferencias", "clave-backend", { method: "POST", body: JSON.stringify({ phone, resumen: "contador", modalidades: ["remoto"] }) })).status, 200);
    // La clave de Vatio no abre la consola, ni la de la consola las herramientas.
    assert.equal((await call("/admin/overview", "clave-backend")).status, 401);
    assert.equal((await call("/tools/ver_perfil", "clave-admin", { method: "POST", body: "{}" })).status, 401);
    assert.equal((await call("/admin/overview", "clave-admin", { method: "POST" })).status, 405);

    const overview = await (await call("/admin/overview?days=7", "clave-admin")).json();
    assert.equal(overview.funnel.sent, 1);
    assert.equal(overview.users_by_country[0].country, "CL");
    const users = await (await call("/admin/users", "clave-admin")).json();
    assert.equal(users[0].phone, "+56 9 •••• 4110");
    assert.equal(users[0].id, phoneId(phone));
    const detail = await (await call(`/admin/users/${users[0].id}`, "clave-admin")).json();
    assert.equal(detail.deliveries[0].job_id, "a");
    // Lo único que escribe: las preferencias, con los campos de guardar_preferencias. El teléfono del cuerpo no
    // cuenta, y no se le buscan ni se le marcan avisos: los evalúa la próxima corrida.
    await addJob(db, { id: "b", title: "Contador de costos" });
    const patch = (id: string, body: unknown) => call(`/admin/users/${id}`, "clave-admin", { method: "PATCH", body: JSON.stringify(body) });
    const patched = await patch(users[0].id, { modalidades: [], excluir: ["atención de público"], phone: "+56911112222" });
    assert.equal(patched.status, 200);
    const fixed = await patched.json();
    assert.deepEqual(fixed.preferencias.modalidades, []);
    assert.deepEqual(fixed.preferencias.excluir, ["atención de público"]);
    assert.equal(fixed.preferencias.resumen, "contador");
    const perfil = await (await call("/tools/ver_perfil", "clave-backend", { method: "POST", body: JSON.stringify({ phone }) })).json();
    assert.deepEqual(perfil.preferencias.excluir, ["atención de público"]);
    assert.equal((await (await call("/admin/users", "clave-admin")).json()).length, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'sent'").get() as { n: number }).n, 1);
    assert.equal((await patch(users[0].id, { cargos: Array.from({ length: 11 }, (_, i) => `cargo ${i}`) })).status, 422);
    assert.equal((await patch("0000000000000000", { excluir: [] })).status, 404);
    assert.equal((await call("/admin/overview", "clave-admin", { method: "PATCH", body: "{}" })).status, 405);
    assert.ok(!JSON.stringify([overview, users, detail, fixed]).includes("48454110"), "un teléfono completo salió de la consola");

    const log = await (await call("/admin/log?limit=50", "clave-admin")).json();
    const tool = log.find((l: any) => l.path === "/tools/guardar_preferencias");
    assert.equal(tool.caller, "backend");
    assert.equal(tool.status, 200);
    assert.equal(tool.phone_id, phoneId(phone));
    const edit = log.find((l: any) => l.method === "PATCH" && l.status === 200);
    assert.equal(edit.caller, "admin");
    assert.equal(edit.phone_id, phoneId(phone));
    assert.ok(log.some((l: any) => l.path === "/admin/overview" && l.status === 401 && l.caller === "anon"));
    assert.ok(!JSON.stringify(log).includes("48454110"));
    // El registro no se puede editar.
    assert.throws(() => db.prepare("UPDATE api_log SET status = 200").run(), /solo agregar/);
  } finally {
    server.close();
  }
  assert.equal(maskPhone("+5215512345678"), "+52 1 •••• 5678");
});

test("sin ADMIN_API_KEY la consola queda apagada", async () => {
  const server = createApp(openDb(":memory:"), fakeEmbed, "k", null, "").listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/overview`, { headers: { authorization: "Bearer " } });
    assert.equal(res.status, 503);
  } finally {
    server.close();
  }
});

test("horario de envío: 8 a 19 h locales, un mensaje al día y otro ese día solo si respondió", () => {
  // 23-11-2026 en Santiago es UTC-3 (verano).
  const at = (utc: string) => new Date(utc);
  assert.equal(localNow("CL", at("2026-11-23T15:00:00Z")).hour, 12);
  assert.equal(canMessageNow({ country: "CL", last_notified_at: null }, at("2026-11-23T15:00:00Z")), true);
  assert.equal(canMessageNow({ country: "CL", last_notified_at: null }, at("2026-11-24T00:07:00Z")), false); // 21:07
  assert.equal(canMessageNow({ country: "CL", last_notified_at: null }, at("2026-11-23T10:30:00Z")), false); // 07:30
  // Ya se le escribió hoy: otro solo si respondió (lo revisa notifyAll en Vatio).
  assert.equal(canMessageNow({ country: "CL", last_notified_at: "2026-11-23T14:00:00Z" }, at("2026-11-23T15:00:00Z")), "if_replied");
  // El de ayer no cuenta: el primero del día sale sin más.
  assert.equal(canMessageNow({ country: "CL", last_notified_at: "2026-11-22T21:00:00Z" }, at("2026-11-23T11:00:00Z")), true); // 8:00
  // La misma hora UTC es otra hora local en México (UTC-6): 9:00 allá.
  assert.equal(canMessageNow({ country: "MX", last_notified_at: null }, at("2026-11-23T15:00:00Z")), true);
  assert.equal(canMessageNow({ country: "MX", last_notified_at: null }, at("2026-11-23T13:30:00Z")), false); // 07:30
});

test("fecha de publicación legible en el mensaje", () => {
  const at = new Date("2026-11-23T15:00:00Z");
  assert.equal(publishedAgo("2026-11-23 09:10", "CL", at), "hoy");
  assert.equal(publishedAgo("2026-11-22", "CL", at), "ayer");
  assert.equal(publishedAgo("2026-11-20 18:00", "CL", at), "hace 3 días");
  assert.equal(publishedAgo("2026-11-02", "CL", at), "el 02-11");
  // Desde un mes se dice cuánto hace, para que no parezca nuevo un aviso de febrero.
  assert.equal(publishedAgo("2026-10-12", "CL", at), "hace un mes");
  assert.equal(publishedAgo("2026-02-05", "CL", at), "hace 9 meses");
  assert.equal(publishedAgo("2025-09-01", "CL", at), "hace más de un año");
  assert.equal(publishedAgo(null, "CL", at), null);
  const job = { id: "a", title: "Diseñador", company: "X", location: "Viña", modality: null, salary: null, url: "https://x", published_at: new Date().toISOString().slice(0, 10), country: "CL" } as any;
  assert.match(formatMessage([job], "+56911112222"), /Publicado hoy/);
});

test("al cambiar el perfil se olvida lo aprobado con el anterior, y lo pendiente que ya no calza no sale", async () => {
  const db = openDb(":memory:");
  await addJob(db, { id: "stgo", title: "Práctica contador Santiago", region: "metropolitana" });
  const tools = createTools(db, fakeEmbed, null);
  const phone = "+56955556666";
  await tools.guardar_preferencias({ phone, resumen: "contador", regiones: ["Metropolitana"] });
  // Queda un aviso de Santiago pendiente del perfil viejo...
  db.prepare("UPDATE deliveries SET status = 'pending' WHERE phone = ?").run(phone);
  await tools.guardar_preferencias({ phone, regiones: ["Valparaíso"] });
  const left = db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE phone = ? AND status = 'pending'").get(phone) as { n: number };
  assert.equal(left.n, 0);
  // ...y si uno quedara igual, el envío lo revisa contra el perfil actual.
  db.prepare("INSERT INTO deliveries (phone, job_id, status, created_at) VALUES (?, 'stgo', 'pending', ?)").run(phone, now());
  const sent: string[] = [];
  const r = await notifyAll(db, async (m) => (sent.push(m.text), { status: 202 }), { ignoreSchedule: true });
  assert.equal(r.sent, 0);
  assert.deepEqual(sent, []);
  assert.equal((db.prepare("SELECT status FROM deliveries WHERE job_id = 'stgo'").get() as any).status, "rejected");
});

test("si el modelo falla, los avisos se reintentan en la próxima corrida", async () => {
  const db = openDb(":memory:");
  const tools = createTools(db, fakeEmbed, null);
  await tools.guardar_preferencias({ phone: "+56900000000", resumen: "enfermera" });
  await new Promise((r) => setTimeout(r, 5));
  await addJob(db, { id: "x", title: "Enfermera UCI" });
  const failed = await matchAll(db, async () => {
    throw new Error("timeout");
  });
  assert.equal(failed.errors.length, 1);
  assert.equal((await matchAll(db, approveAll)).pending, 1);
});

test("Computrabajo: solo las regiones que piden las personas activas", async () => {
  const slugs = (key: string, users: Array<{ regions: string[] }>) => regionsFor(key, users).map((r) => r.slug).sort();
  assert.deepEqual(slugs("computrabajo-cl", []), []);
  assert.deepEqual(slugs("computrabajo-cl", [{ regions: ["valparaiso"] }]), ["valparaiso"]);
  assert.deepEqual(slugs("computrabajo-cl", [{ regions: ["valparaiso"] }, { regions: ["metropolitana", "biobio"] }]), ["biobio", "rmetropolitana", "valparaiso"]);
  // Alguien sin regiones acepta todo su país.
  assert.equal(regionsFor("computrabajo-cl", [{ regions: ["valparaiso"] }, { regions: [] }]).length, 14);
  // La misma clave que usa el match: "CDMX" es la página "Ciudad de México DF", no "Estado de México".
  assert.deepEqual(slugs("computrabajo-mx", [{ regions: [regionOf("MX", "CDMX")!] }]), ["ciudad-de-mexico"]);
  // Sin nadie activo en el país, la corrida no le pide nada a Computrabajo.
  const res = await sources(openDb(":memory:"))["computrabajo-cl"]!.source({ maxPages: 1, isKnown: () => false });
  assert.deepEqual([res.jobs.length, res.pages, res.note], [0, 0, "0 de 14 regiones"]);
});

test("Computrabajo: una región bloqueada no detiene a las demás; si fallan todas, la fuente queda con el 403", async () => {
  const listing = `<div><article class="box_offer" data-id='74C2C0B04F7E027161373E686DCF3405' id="x">
    <h2><a class="js-o-link fc_base" href="/ofertas-de-trabajo/oferta-de-trabajo-de-asesor-74C2C0B04F7E027161373E686DCF3405#lc=ListOffers-Score-0">
      Asesor </a></h2></article></div>`;
  const detail = `<script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting", description: "Atención al cliente", datePosted: "2026-11-21", hiringOrganization: { name: "Activos" },
  })}</script>`;
  const blocked = (url: string): never => { throw new HttpError(url, 403); };
  const regions = regionsFor("computrabajo-cl", [{ regions: ["valparaiso", "biobio"] }]);
  const get = async (url: string) => (url.includes("/ofertas-de-trabajo/") ? detail : url.includes("biobio") ? blocked(url) : listing);
  const res = await computrabajo("computrabajo-cl", regions, get)({ maxPages: 1, isKnown: () => false });
  assert.deepEqual(res.jobs.map((j) => j.region), ["valparaiso"]);
  assert.match(res.note!, /^2 de 14 regiones; fallaron 1: https:\/\/cl\.computrabajo\.com\/.*biobio.* respondió 403$/);
  await assert.rejects(computrabajo("computrabajo-cl", regions, async (url) => blocked(url))({ maxPages: 1, isKnown: () => false }), /respondió 403/);
});

test("proxy: un bloqueo o un corte se reintenta por otro túnel; un 404 no", async () => {
  let calls = 0;
  let rotations = 0;
  const flaky = async () => {
    if (++calls < 3) throw new HttpError("https://x", 403);
    return "ok";
  };
  assert.equal(await withRetries(4, flaky, () => rotations++, 0), "ok");
  assert.deepEqual([calls, rotations], [3, 2]);
  calls = 0;
  await assert.rejects(withRetries(4, async () => { calls++; throw new HttpError("https://x", 404); }, () => {}, 0), /respondió 404/);
  assert.equal(calls, 1);
  calls = 0;
  // Agotados los intentos, queda el error del último: "respondió 403".
  await assert.rejects(withRetries(4, async () => { calls++; throw new HttpError("https://x", 403); }, () => {}, 0), /^Error: https:\/\/x respondió 403$/);
  assert.equal(calls, 4);
  assert.ok(retryable(new Error("fetch failed")) && retryable(new HttpError("https://x", 502)) && !retryable(new HttpError("https://x", 410)));
});

test("un perfil que pide una región que nadie pedía la trae en segundo plano", async () => {
  const db = openDb(":memory:");
  const calls: string[][] = [];
  const tools = createTools(db, fakeEmbed, null, {
    profileSaved: (old, user) => calls.push(newRegions(db, old, user)?.regions.map((r) => r.slug) ?? []),
  });
  await tools.guardar_preferencias({ phone: "+56911112222", resumen: "vendedor", regiones: ["Valparaíso"] });
  // Otra persona en la misma región: la corrida ya la recorre.
  await tools.guardar_preferencias({ phone: "+56933334444", resumen: "cajero", regiones: ["Valparaíso"] });
  // Sumar una región nueva la trae; cambiar otra cosa del perfil no.
  await tools.guardar_preferencias({ phone: "+56933334444", regiones: ["Valparaíso", "Biobío"] });
  await tools.guardar_preferencias({ phone: "+56933334444", resumen: "cajero de supermercado" });
  // Mientras estuvo en pausa nadie pedía Biobío: al reanudar se trae.
  await tools.pausar_avisos({ phone: "+56933334444", pausar: true });
  // Vatio no manda `pausar: false`: si no viene, es reanudar.
  await tools.pausar_avisos({ phone: "+56933334444" });
  // Sin regiones: todo el país, menos lo que ya se recorre.
  await tools.guardar_preferencias({ phone: "+56955556666", resumen: "bodeguero" });
  assert.deepEqual(calls.slice(0, 5), [["valparaiso"], [], ["biobio"], [], ["biobio"]]);
  assert.equal(calls[5]!.length, 12);
});

test("un mensaje automático al día, y otro el mismo día solo si respondió al anterior", async () => {
  const db = openDb(":memory:");
  const phone = "+56977778888";
  await createTools(db, fakeEmbed, null).guardar_preferencias({ phone, resumen: "contador" });
  const pend = async (id: string) => {
    await addJob(db, { id, title: `Contador ${id}` });
    db.prepare("INSERT INTO deliveries (phone, job_id, score, status, created_at) VALUES (?, ?, 1, 'pending', ?)").run(phone, id, now());
  };
  // En Santiago es UTC-3: 12:00Z son las 9:00.
  let nextId = 100;
  const send: Sender = async () => ({ status: 202, mode: "text", id: nextId++ });
  const answered = new Set<number>();
  const asked: number[] = [];
  const replied: Replied = async (id) => (asked.push(id), answered.has(id));
  const run = (utc: string) => notifyAll(db, send, { at: new Date(utc), replied });
  const notifiedAt = (utc: string) => db.prepare("UPDATE users SET last_notified_at = ? WHERE phone = ?").run(utc, phone);

  await pend("a");
  assert.equal((await run("2026-11-23T12:00:00Z")).sent, 1);
  assert.deepEqual(asked, []);
  notifiedAt("2026-11-23T12:00:00Z");

  // Aparece otro, pero no respondió al de la mañana: espera.
  await pend("b");
  assert.equal((await run("2026-11-23T12:30:00Z")).waiting, 1);
  assert.deepEqual(asked, [100]);
  // Respondió: la conversación está tibia y sale en la corrida siguiente.
  answered.add(100);
  assert.equal((await run("2026-11-23T13:00:00Z")).sent, 1);
  notifiedAt("2026-11-23T13:00:00Z");

  // A ese no respondió: el siguiente espera hasta mañana, y mañana sale sin preguntar.
  await pend("c");
  assert.equal((await run("2026-11-23T19:00:00Z")).waiting, 1);
  assert.deepEqual(asked, [100, 100, 101]);
  assert.equal((await run("2026-11-24T11:00:00Z")).sent, 1);
  assert.equal(asked.length, 3);
  notifiedAt("2026-11-24T11:00:00Z");

  // Un mensaje de antes de guardar su id cuenta como sin respuesta, sin preguntarle a Vatio.
  db.prepare("UPDATE users SET last_message_id = NULL WHERE phone = ?").run(phone);
  await pend("d");
  assert.equal((await run("2026-11-24T15:00:00Z")).waiting, 1);
  assert.equal(asked.length, 3);
  // Si Vatio falla al leer el mensaje, también espera, y el error queda en el resultado.
  db.prepare("UPDATE users SET last_message_id = 102 WHERE phone = ?").run(phone);
  const failing = await notifyAll(db, send, { at: new Date("2026-11-24T15:00:00Z"), replied: async () => { throw new Error("Vatio 500"); } });
  assert.equal(failing.waiting, 1);
  assert.deepEqual(failing.errors, ["Vatio 500"]);
});

test("una base de antes pierde las columnas de las frecuencias y conserva lo demás", () => {
  const path = join(mkdtempSync(join(tmpdir(), "chambeando-")), "old.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE users (phone TEXT PRIMARY KEY, country TEXT NOT NULL, summary TEXT NOT NULL, roles TEXT NOT NULL DEFAULT '[]',
    regions TEXT NOT NULL DEFAULT '[]', modalities TEXT NOT NULL DEFAULT '[]', exclude TEXT NOT NULL DEFAULT '[]', embedding BLOB,
    active INTEGER NOT NULL DEFAULT 1, frequency TEXT NOT NULL DEFAULT 'apenas', notify_hour INTEGER, matched_until TEXT NOT NULL,
    last_template_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, name TEXT, min_salary INTEGER)`);
  old.prepare("INSERT INTO users (phone, country, summary, frequency, notify_hour, matched_until, created_at, updated_at) VALUES (?, 'CL', 'contador', 'semanal', 16, ?, ?, ?)")
    .run("+56911112222", now(), now(), now());
  old.close();
  const db = openDb(path);
  const cols = (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const gone of ["frequency", "notify_hour", "last_template_at"]) assert.ok(!cols.includes(gone), gone);
  assert.equal((db.prepare("SELECT summary FROM users").get() as { summary: string }).summary, "contador");
});

test("el mensaje automático ofrece los avisos que no caben", () => {
  const phone = "+56977778888";
  const job = { id: "a", title: "Diseñador", company: "X", location: "Viña", modality: null, salary: null, url: "https://x", published_at: null, country: "CL" } as any;
  assert.match(formatMessage([job], phone, 4), /Tengo 4 avisos más para ti/);
  assert.doesNotMatch(formatMessage([job], phone), /más para ti/);
});

const gobPosting = (over: Record<string, unknown> = {}, id = "desarrollador-junior-magnet-santiago") => ({
  id,
  type: "job",
  attributes: {
    title: "Desarrollador Full-Stack Junior ",
    description_headline: "Requisitos mínimos",
    description: "<ul><li>Entre 0 y 2 años de experiencia</li></ul>",
    functions_headline: "Propósito del cargo",
    functions: "<p>Construir y mantener <b>features</b></p>",
    benefits: null,
    remote_modality: "hybrid",
    countries: ["Chile"],
    min_salary: 1600,
    max_salary: 1900,
    published_at: 1795469057,
    company: { data: { id: 1517, type: "company", attributes: { name: "Magnet" } } },
    modality: { data: { id: 1, type: "modality", attributes: { name: "Full time" } } },
    seniority: { data: { id: 2, type: "seniority", attributes: { name: "Junior" } } },
    location_cities: { data: [{ id: 1, type: "location_city", attributes: { name: "Santiago", country: "Chile" } }] },
    ...over,
  },
  links: { public_url: `https://www.getonbrd.com/jobs/${id}` },
});

test("Get on Board: convierte un aviso, con el sueldo en dólares como texto", () => {
  const job = getonboardJob("CL", gobPosting())!;
  assert.equal(job.id, "getonboard-cl:desarrollador-junior-magnet-santiago");
  assert.equal(job.source, "getonboard");
  assert.equal(job.url, "https://www.getonbrd.com/jobs/desarrollador-junior-magnet-santiago");
  assert.deepEqual([job.title, job.company, job.location, job.region, job.modality], ["Desarrollador Full-Stack Junior", "Magnet", "Santiago, Chile", "metropolitana", "hibrido"]);
  assert.equal(jobKind(job.job_type, job.title), "full_time");
  // El sueldo de Get on Board es bruto en dólares: no entra en `salary` (moneda local) para no filtrar mal.
  assert.equal(job.salary, null);
  assert.match(job.description, /^Sueldo bruto: US\$1,600 a US\$1,900 al mes\.\n\nExperiencia: Junior\.\n\nRequisitos mínimos\nEntre 0 y 2 años/);
  assert.equal(job.published_at, new Date(1795469057 * 1000).toISOString());
  // Remoto: sirve en cualquier región; se ofrece en todos los países que busquen.
  const remote = gobPosting({ countries: ["Remote"], remote_modality: "remote_local", location_cities: { data: [] } }, "qa-remote");
  assert.ok(availableIn("CO", remote));
  assert.deepEqual(
    (({ region, modality, location }) => ({ region, modality, location }))(getonboardJob("CO", remote)!),
    { region: null, modality: "remoto", location: null },
  );
  assert.ok(!availableIn("CL", gobPosting({ countries: ["Uruguay"] })));
  // Una ciudad que no es una región conocida no inventa región.
  assert.equal(getonboardJob("CO", gobPosting({ countries: ["Colombia"], remote_modality: "no_remote", location_cities: { data: [{ attributes: { name: "Medellín", country: "Colombia" } }] } }))!.region, null);
  assert.equal(getonboardJob("CO", gobPosting({ countries: ["Colombia"], location_cities: { data: [{ attributes: { name: "Bogotá", country: "Colombia" } }] } }))!.region, "bogota");
  assert.equal(getonboardJob("CL", { id: "x", attributes: {} }), null);
  // El mensaje dice de qué portal viene el aviso y muestra el sueldo en dólares.
  const text = formatMessage([{ ...job, published_at: new Date().toISOString() } as any], "+56911112222");
  assert.match(text, /Sueldo bruto: US\$1,600 a US\$1,900 al mes\./);
  assert.match(text, /Publicado hoy en Get on Board/);
});

test("Get on Board: recorre todas las páginas y, con el listado entero, deja de ofrecer lo que se cerró", async () => {
  const pages: Record<number, unknown> = {
    1: { data: [gobPosting({}, "a"), gobPosting({ countries: ["Uruguay"] }, "uy")], meta: { total_pages: 2 } },
    2: { data: [gobPosting({}, "b")], meta: { total_pages: 2 } },
  };
  const urls: string[] = [];
  const get = async (url: string) => (urls.push(url), pages[Number(new URL(url).searchParams.get("page"))]);
  const full = await getonboard("CL", get)({ maxPages: 10, isKnown: (id) => id === "getonboard-cl:a" });
  assert.deepEqual(full.jobs.map((j) => j.id), ["getonboard-cl:b"]);
  assert.deepEqual(full.listed, ["getonboard-cl:a", "getonboard-cl:b"]);
  assert.match(urls[0]!, /country_code=cl&per_page=120&page=1&expand=/);
  // Sin recorrer todo, no se sabe qué se cerró.
  const partial = await getonboard("CL", get)({ maxPages: 1, isKnown: () => false });
  assert.equal(partial.listed, undefined);

  const db = openDb(":memory:");
  const tools = createTools(db, fakeEmbed, null);
  const phone = "+56966667777";
  await tools.guardar_preferencias({ phone, resumen: "desarrollador junior" });
  const source = (listed: string[], jobs = [] as NewJob[]) => async () => ({ jobs, pages: 1, invalid: 0, listed });
  await ingest(db, fakeEmbed, { "getonboard-cl": { source: source(["getonboard-cl:a", "getonboard-cl:b"], [getonboardJob("CL", gobPosting({}, "a"))!, getonboardJob("CL", gobPosting({ title: "Analista de datos" }, "b"))!]), maxPages: 1 } });
  db.prepare("INSERT INTO deliveries (phone, job_id, status, created_at) VALUES (?, 'getonboard-cl:b', 'pending', ?)").run(phone, now());
  const report = await ingest(db, fakeEmbed, { "getonboard-cl": { source: source(["getonboard-cl:a"]), maxPages: 1 } });
  assert.equal(report["getonboard-cl"]!.closed, 1);
  const b = db.prepare("SELECT embedding FROM jobs WHERE id = 'getonboard-cl:b'").get() as { embedding: unknown };
  assert.equal(b.embedding, null);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE job_id = 'getonboard-cl:b'").get() as { n: number }).n, 0);
  assert.notEqual((db.prepare("SELECT embedding FROM jobs WHERE id = 'getonboard-cl:a'").get() as { embedding: unknown }).embedding, null);
});

const bneOferta = (over: Record<string, unknown> = {}) => ({
  id: 1604678,
  codigoOferta: "2026-157353",
  empresario: { idEmpresario: 121682, nombreComercial: "Gepys ", logotipo: "iVBOR..." },
  nombrePuesto: "Técnico/a en Enfermería Arsenalero/a",
  region: { id: 378, nombre: "Metropolitana" },
  comuna: { id: 1135, nombre: "Estación Central" },
  rangoSalarial: { id: 3, nombre: "$610.001 - $760.000" },
  jornadaLaboral: { id: 9, nombre: "Jornada Completa" },
  fechaPublicacion: "2026-11-24",
  descripcion: "Funciones:\n•\tVigilar al paciente.\n\nRequisitos:\n•\tTitulado TENS.",
  esEnadi: false,
  ...over,
});

test("BNE: convierte un aviso, con el rango de sueldo como texto y el tope para el filtro", () => {
  const job = bneJob(bneOferta())!;
  assert.equal(job.id, "bne:1604678");
  assert.equal(job.url, "https://www.bne.gob.cl/ofertas/1604678");
  assert.deepEqual([job.company, job.location, job.region, job.job_type], ["Gepys", "Estación Central, Metropolitana", "metropolitana", "Jornada Completa"]);
  assert.equal(jobKind(job.job_type, job.title), "full_time");
  // El filtro de sueldo mínimo mira el tope: un aviso de hasta $760.000 sirve a quien pide $700.000.
  assert.equal(job.salary, 760000);
  const user = { regions: [], modalities: [], exclude: [], job_kinds: [] as JobKind[] };
  assert.ok(passesFilters({ ...user, min_salary: 700000 }, job));
  assert.ok(!passesFilters({ ...user, min_salary: 800000 }, job));
  assert.match(job.description, /^Sueldo: \$610\.001 a \$760\.000\.\n\nFunciones:\n• Vigilar al paciente\./);
  // El mensaje muestra el rango, no el tope solo, y dice de dónde viene.
  const text = formatMessage([{ ...job, published_at: new Date().toISOString() } as any], "+56911112222");
  assert.match(text, /Sueldo: \$610\.001 a \$760\.000\./);
  assert.doesNotMatch(text, /Sueldo: \$760/);
  assert.match(text, /Publicado hoy en la Bolsa Nacional de Empleo/);
  // Lo mismo ve el agente en `sueldo`; un sueldo de una sola cifra va igual, como texto.
  assert.equal(salaryLine(job), "Sueldo: $610.001 a $760.000.");
  assert.match(salaryLine({ salary: 760000, description: "Funciones: vigilar." })!, /^Sueldo: \$760[.,]000$/);
  // Sin tope no hay cifra, para no descartar un aviso que podría pagar lo pedido.
  assert.deepEqual(salaryOf("Más de $3.000.000"), { salary: null, line: "Sueldo: más de $3.000.000." });
  assert.deepEqual(salaryOf("Menos de $460.000"), { salary: 460000, line: "Sueldo: hasta $460.000." });
  assert.deepEqual(salaryOf("A convenir"), { salary: null, line: null });
  assert.equal(bneJob(bneOferta({ rangoSalarial: null, empresario: null }))?.salary, null);
  assert.equal(bneJob(bneOferta({ nombrePuesto: " " })), null);
});

test("BNE: recorre del más nuevo al más viejo y para en la primera página sin nada nuevo", async () => {
  const pages: Record<string, unknown> = {
    0: { content: [bneOferta({ id: 3 }), bneOferta({ id: 2 }), { id: "roto" }], totalPages: 3, last: false },
    1: { content: [bneOferta({ id: 1 })], totalPages: 3, last: false },
    2: { content: [bneOferta({ id: 0 })], totalPages: 3, last: true },
  };
  const urls: string[] = [];
  const get = async (url: string) => (urls.push(url), pages[new URL(url).searchParams.get("page")!]);
  const res = await bne(get)({ maxPages: 10, isKnown: (id) => id === "bne:1" });
  assert.deepEqual(res.jobs.map((j) => j.id), ["bne:3", "bne:2"]);
  assert.equal(res.invalid, 1);
  assert.equal(urls.length, 2);
  assert.match(urls[0]!, /\/api\/ofertas\/busqueda\?page=0&size=50$/);
});

/** Una página del buscador de Magneto: el payload RSC partido en dos `push`, con la descripción como texto aparte. */
function magnetoHtml(rows: unknown[], texts: Record<string, string>): string {
  const tRows = Object.entries(texts).map(([id, t]) => `${id}:T${Buffer.byteLength(t).toString(16)},${t}`).join("");
  const payload = `0:["$","div",null,{}]\n${tRows}5:{"algorithm":"x","totalRows":2,"rows":${JSON.stringify(rows)}}\n`;
  const cut = 31;
  return [payload.slice(0, cut), payload.slice(cut)]
    .map((p) => `<script>self.__next_f.push([1,${JSON.stringify(p)}])</script>`)
    .join("");
}

const magnetoRow = (over: Record<string, unknown> = {}) => ({
  id: 1150446,
  title: "AUXILIAR DE REFRIGERACIÓN\tMEDELLIN",
  jobSlug: "auxiliar-de-refrigeracion-medellin-1150446",
  status: "published",
  cities: ["Medellín", "Envigado"],
  departments: ["Antioquia"],
  salary: 2050000,
  minSalary: 2050000,
  maxSalary: 2400000,
  toAgree: false,
  currencyCode: "COP",
  description: "$1a",
  companyName: "Frío SAS",
  confidential: false,
  publishDate: "2026-11-24T17:51:31.711Z",
  contractOrder: { id: 2, name: "Por obra o labor", order: 2 },
  isRemote: false,
  experienceMonthsNumber: 6,
  educationLevel: [{ id: 1, name: "Técnico", order: 2 }],
  ...over,
});

test("Magneto: lee los avisos del payload de Next.js, con la descripción aparte", () => {
  // Texto con caracteres de varios bytes: el largo de la fila T va en bytes UTF-8.
  const html = magnetoHtml(
    [
      magnetoRow(),
      magnetoRow({ id: 2, jobSlug: "aprendiz-2", title: "Aprendiz SST", description: "$$5 de propina", confidential: true, companyName: "Confidencial", toAgree: true, contractOrder: { name: "Contrato de aprendizaje" }, cities: ["Bogotá, D.C.", "Soacha"], departments: ["Bogotá D.C.", "Cundinamarca"], experienceMonthsNumber: 0, isRemote: true }),
    ],
    { "1a": "<p>Técnico en refrigeración – mínimo 6 meses 📌</p><ul><li>Salario: $2.050.000</li></ul>" },
  );
  const [a, b] = magnetoPage(html).map(magnetoJob);
  assert.equal(a!.id, "magneto:1150446");
  assert.equal(a!.url, "https://www.magneto365.com/co/empleos/auxiliar-de-refrigeracion-medellin-1150446");
  assert.deepEqual([a!.title, a!.company, a!.location, a!.region], ["AUXILIAR DE REFRIGERACIÓN MEDELLIN", "Frío SAS", "Medellín, Envigado, Antioquia", "antioquia"]);
  assert.equal(a!.salary, 2400000);
  assert.equal(a!.description, "Sueldo: $2.050.000 a $2.400.000.\n\nExperiencia: 6 meses.\n\nEstudios: Técnico.\n\nTécnico en refrigeración – mínimo 6 meses 📌\nSalario: $2.050.000");
  assert.equal(a!.published_at, "2026-11-24T17:51:31.711Z");
  // Confidencial, a convenir, contrato de aprendizaje (la práctica en Colombia) y remoto o híbrido.
  assert.deepEqual([b!.company, b!.salary, b!.location, b!.region, b!.modality], [null, null, "Bogotá, D.C., Soacha", "bogota", null]);
  assert.equal(jobKind(b!.job_type, b!.title), "practica");
  assert.equal(b!.description, "Modalidad: remoto o híbrido.\n\nSin experiencia.\n\nEstudios: Técnico.\n\n$5 de propina");
  assert.equal(magnetoJob({ id: 3, title: "Sin slug" }), null);
  assert.deepEqual(magnetoPage("<html>sin payload</html>"), []);
});

test("Magneto: pagina por ruta, sin \"?\", y para en la primera página sin nada nuevo", async () => {
  const pages: Record<string, string> = {
    [magnetoUrl(1)]: magnetoHtml([magnetoRow({ id: 30, jobSlug: "a-30" }), magnetoRow({ id: 20, jobSlug: "a-20" })], { "1a": "<p>Texto</p>" }),
    [magnetoUrl(2)]: magnetoHtml([magnetoRow({ id: 10, jobSlug: "a-10" })], { "1a": "<p>Texto</p>" }),
  };
  const urls: string[] = [];
  const get = async (url: string) => (urls.push(url), pages[url]!);
  const res = await magneto(get)({ maxPages: 25, isKnown: (id) => id === "magneto:10" });
  assert.deepEqual(res.jobs.map((j) => j.id), ["magneto:30", "magneto:20"]);
  assert.deepEqual(urls, [
    "https://www.magneto365.com/co/trabajos/buscar",
    "https://www.magneto365.com/co/trabajos/buscar/pagina-2",
  ]);
  assert.equal(res.note, undefined);
  // Si cada página repite la primera (como `?paginator[page]=N`, que el servidor ignora), para en la segunda y lo dice.
  const same = await magneto(async () => pages[magnetoUrl(1)]!)({ maxPages: 25, isKnown: () => false });
  assert.deepEqual([same.jobs.length, same.pages], [2, 2]);
  assert.match(same.note!, /la página 2 repite la anterior/);
  // Una primera página sin avisos es un cambio en la página: la fuente queda con error.
  await assert.rejects(magneto(async () => "<html></html>")({ maxPages: 1, isKnown: () => false }), /no trae avisos/);
});

const ctItem = (id: string, title = "VENDEDOR / BODEGUERO CON LICENCIA CLASE&#8230;") => `<div class="job-item with-thumb destacado no-hover ">
    <div class="col-sm-12 px-0" onclick="window.location.href='https://www.chiletrabajos.cl/trabajo/aviso-${id}';">
        <h2 class="title overflow-hidden">
            <a href="https://www.chiletrabajos.cl/trabajo/aviso-${id}" class="font-weight-bold">${title}</a>
        </h2>
        <h3 class="meta">Construtubos, <a href="https://www.chiletrabajos.cl/ciudad/santiago.html">Santiago</a></h3>
    </div></div>`;

// Como lo escribe el listado filtrado por fecha; el completo dice "Se han encontrado N trabajos".
const ctListing = (total: number, ids: string[]) =>
  `<div class="titulo"> <h1 class="font-weight-bold"> Trabajos </h1> </div> <div class="title-lines"> <h2 class="">${total} Trabajos </h2> </div>${ids.map((id) => ctItem(id)).join("")}`;

const ctDetail = (fields: Record<string, unknown>) => `<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
  <script type='application/ld+json'>${JSON.stringify({ "@context": "https://schema.org/", "@type": "JobPosting", ...fields })}</script>`;

const ctPosting = {
  baseSalary: { "@type": "MonetaryAmount", currency: "CLP", value: { "@type": "QuantitativeValue", Value: "650000", unitText: "MONTH" } },
  datePosted: "2026-11-24 09:39:24",
  hiringOrganization: { "@type": "Organization", name: "CONSTRUTUBOS" },
  industry: "Ventas / Comercial",
  jobLocation: { address: { addressLocality: "Santiago", addressRegion: "RM", addressCountry: "CL" } },
  employmentType: "FULL_TIME",
  title: "VENDEDOR / BODEGUERO CON LICENCIA CLASE B (RUBRO FERRETERÍA)",
  description: "Descripción del cargo:\r\nAtención en mesón y bodega.\r\n\r\n•\tModalidad: Presencial.\r\n•\tRenta líquida: $650.000.",
};

test("Chiletrabajos: lee el listado HTML y el JSON-LD del aviso", () => {
  const { total, items } = chiletrabajosListing(ctListing(638, ["3937582"]) + `<div class="job-item"><p>sin enlace</p></div>`);
  assert.equal(total, 638);
  assert.deepEqual(items, [{
    id: "3937582",
    url: "https://www.chiletrabajos.cl/trabajo/aviso-3937582",
    title: "VENDEDOR / BODEGUERO CON LICENCIA CLASE…",
  }]);
  assert.equal(chiletrabajosListing("<html>bloqueado</html>").total, null);
  assert.equal(chiletrabajosListing(`<h2 class="">Se han encontrado 34270 trabajos </h2>`).total, 34270);
  assert.equal(chiletrabajosListing(ctListing(0, [])).total, 0);

  const job = chiletrabajosJob(items[0]!, ctDetail(ctPosting))!;
  assert.equal(job.id, "chiletrabajos:3937582");
  assert.equal(job.source, "chiletrabajos");
  assert.equal(job.country, "CL");
  // El título completo sale del detalle; el del listado viene cortado.
  assert.equal(job.title, "VENDEDOR / BODEGUERO CON LICENCIA CLASE B (RUBRO FERRETERÍA)");
  assert.deepEqual([job.company, job.location, job.region, job.modality], ["CONSTRUTUBOS", "Santiago, Metropolitana", "metropolitana", "presencial"]);
  assert.equal(job.salary, 650000);
  assert.equal(jobKind(job.job_type, job.title), "full_time");
  assert.equal(job.description, "Descripción del cargo:\nAtención en mesón y bodega.\n• Modalidad: Presencial.\n• Renta líquida: $650.000.");
  assert.equal(job.published_at, "2026-11-24 09:39:24");

  // Empresa anónima, sueldo a convenir (0), región por su código y jornada doble.
  const other = chiletrabajosJob(items[0]!, ctDetail({
    ...ctPosting,
    hiringOrganization: { name: "ANÓNIMO" },
    baseSalary: { currency: "CLP", value: { Value: 0, unitText: "MONTH" } },
    jobLocation: { address: { addressLocality: "Concepción", addressRegion: "BI" } },
    employmentType: "PART_TIME, FULL_TIME",
  }))!;
  assert.deepEqual([other.company, other.salary, other.location, other.region], [null, null, "Concepción, Biobío", "biobio"]);
  assert.equal(jobKind(other.job_type, other.title), "part_time");
  for (const [code, region] of [["AP", "arica"], ["LI", "ohiggins"], ["NB", "nuble"], ["AR", "araucania"], ["LR", "los-rios"], ["AI", "aysen"]]) {
    const j = chiletrabajosJob(items[0]!, ctDetail({ ...ctPosting, jobLocation: { address: { addressLocality: "X", addressRegion: code } } }));
    assert.equal(j?.region, region, code);
  }
  assert.equal(chiletrabajosJob(items[0]!, ctDetail({ ...ctPosting, hiringOrganization: { name: "Empresa confidencial" } }))?.company, null);
  // Las prácticas son una categoría y se publican como FULL_TIME.
  const practice = chiletrabajosJob(items[0]!, ctDetail({ ...ctPosting, title: "Asistente de TI", industry: "Prácticas profesionales" }))!;
  assert.equal(jobKind(practice.job_type, practice.title), "practica");
  // Sin JSON-LD no hay aviso.
  assert.equal(chiletrabajosJob(items[0]!, "<html>sin datos</html>"), null);
  // Un salto de línea sin escapar dentro del JSON no lo invalida.
  const raw = `<script type='application/ld+json'>{"@type":"JobPosting","title":"Bodeguero","description":"Línea 1
línea 2"}</script>`;
  assert.equal(chiletrabajosJob(items[0]!, raw)?.title, "Bodeguero");
});

test("Chiletrabajos: recorre todo el listado de hoy, salta lo conocido y respeta el tope de detalles", async () => {
  const pages: Record<string, string> = {
    [listingUrl(1, 1)]: ctListing(35, ["1", "2", "3"]),
    [listingUrl(1, 2)]: ctListing(35, ["3", "4", "5"]),
  };
  const urls: string[] = [];
  const get = async (url: string) => {
    urls.push(url);
    if (url.endsWith("aviso-4")) throw new Error("404");
    return pages[url] ?? ctDetail({ ...ctPosting, title: `Aviso ${url.split("-").pop()}` });
  };
  const at10 = () => new Date("2026-11-24T13:00:00Z"); // 10:00 en Chile
  const pause = async () => {};
  const run = await chiletrabajos({ get, now: at10, pause })({ maxPages: 10, isKnown: (id) => id === "chiletrabajos:1" });
  // El 1 ya se conocía, el 3 se repite en la página 2 y el 4 falló.
  assert.deepEqual(run.jobs.map((j) => j.id), ["chiletrabajos:2", "chiletrabajos:3", "chiletrabajos:5"]);
  assert.equal(run.invalid, 1);
  assert.equal(run.pages, 2);
  assert.equal(run.note, "hoy: 2 de 2 páginas");
  assert.equal(urls[0], "https://www.chiletrabajos.cl/encuentra-un-empleo?fecha=1&f=2");
  assert.ok(urls.includes("https://www.chiletrabajos.cl/encuentra-un-empleo/30?fecha=1&f=2"));

  // Con tope, deja de pedir y lo que falta queda para la próxima corrida.
  const capped = await chiletrabajos({ get, now: at10, pause, maxDetails: 1 })({ maxPages: 10, isKnown: () => false });
  assert.deepEqual(capped.jobs.map((j) => j.id), ["chiletrabajos:1"]);
  assert.equal(capped.pages, 1);
  assert.match(capped.note!, /tope de 1 detalles/);

  // Antes de las 2 de la mañana se recorre desde ayer.
  urls.length = 0;
  const night = await chiletrabajos({ get: async (url) => (urls.push(url), ctListing(0, [])), now: () => new Date("2026-11-24T04:00:00Z"), pause })(
    { maxPages: 10, isKnown: () => false },
  );
  assert.deepEqual(urls, ["https://www.chiletrabajos.cl/encuentra-un-empleo?fecha=2&f=2"]);
  assert.equal(night.jobs.length, 0);

  // Desde las 21 de Chile, en UTC ya es mañana y el "hoy" del portal viene vacío: también desde ayer. Un listado con 0
  // avisos trae igual los destacados.
  urls.length = 0;
  const evening = await chiletrabajos({
    get: async (url) => (urls.push(url), url.includes("encuentra-un-empleo") ? ctListing(0, ["9"]) : ctDetail(ctPosting)),
    now: () => new Date("2026-11-25T01:42:00Z"), // 22:42 del 24 en Chile
    pause,
  })({ maxPages: 10, isKnown: () => false });
  assert.equal(urls[0], "https://www.chiletrabajos.cl/encuentra-un-empleo?fecha=2&f=2");
  assert.deepEqual(evening.jobs.map((j) => j.id), ["chiletrabajos:9"]);
  assert.equal(evening.note, "desde ayer: 1 de 1 páginas");

  // Una página que no es el listado (bloqueo o cambio del HTML) deja la fuente con error.
  await assert.rejects(
    chiletrabajos({ get: async () => "<html>Access denied</html>", now: at10, pause })({ maxPages: 10, isKnown: () => false }),
    /no trae el listado/,
  );
});
