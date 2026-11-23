import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../src/config.ts";
import { now, openDb, toBlob } from "../src/db.ts";
import { linkToken, recordClick, stats } from "../src/feedback.ts";
import { maskPhone, phoneId } from "../src/admin.ts";
import { createApp } from "../src/server.ts";
import type { AddressInfo } from "node:net";
import { dedupeKey, ingest, localityOf, sameLocality } from "../src/ingest.ts";
import type { Embedder } from "../src/embed.ts";
import { parseVerdicts, type Judge } from "../src/llm.ts";
import { matchAll, passesFilters } from "../src/match.ts";
import { notifyAll, type Sender } from "../src/notify.ts";
import { parseListing, toJob as computrabajoJob } from "../src/sources/computrabajo.ts";
import { parseJobintDate, toJob as jobintJob } from "../src/sources/jobint.ts";
import { toJob as trabajandoJob } from "../src/sources/trabajando.ts";
import type { NewJob } from "../src/sources/types.ts";
import type { JobKind } from "../src/text.ts";
import { createTools } from "../src/tools.ts";
import { countryOfPhone, jobKind, modalityOf, normalizePhone, regionKey, regionOf } from "../src/text.ts";

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
  const user = { regions: ["metropolitana"], modalities: [], min_salary: 900000, exclude: ["call center"], job_kinds: [] as JobKind[] };
  const job = { title: "Contador", region: "metropolitana", modality: null, salary: null, job_type: null as string | null };
  assert.equal(passesFilters(user, job), true);
  assert.equal(passesFilters(user, { ...job, region: "biobio" }), false);
  assert.equal(passesFilters(user, { ...job, region: "biobio", modality: "remoto" }), true);
  assert.equal(passesFilters(user, { ...job, region: null }), true);
  assert.equal(passesFilters(user, { ...job, salary: 600000 }), false);
  assert.equal(passesFilters(user, { ...job, title: "Ejecutivo Call Center" }), false);
  assert.equal(passesFilters({ ...user, modalities: ["remoto"] }, { ...job, modality: "presencial" }), false);
  // Tipo de trabajo: quien busca práctica no recibe empleos de jornada completa, y al revés.
  const intern = { ...user, job_kinds: ["practica"] as JobKind[] };
  assert.equal(passesFilters(intern, { ...job, job_type: "Full-time" }), false);
  assert.equal(passesFilters(intern, { ...job, title: "Práctica contabilidad", job_type: "Full-time" }), true);
  assert.equal(passesFilters(intern, job), true);
  assert.equal(passesFilters({ ...user, job_kinds: ["full_time", "part_time"] }, { ...job, title: "Practicante de finanzas" }), false);
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
  const n1 = await notifyAll(db, open);
  assert.equal(n1.sent, 1);
  assert.match(sentTexts[0]!, /Contador tributario/);
  assert.equal((await notifyAll(db, open)).sent, 0);

  await tools.registrar_opinion({ phone, aviso_id: "d", util: false, motivo: "piden inglés" });
  await assert.rejects(tools.registrar_opinion({ phone, aviso_id: "zzz", util: true }), /No le hemos mandado/);

  // Ventana cerrada: una sola plantilla por día y el aviso sigue pendiente hasta que la persona responde.
  await new Promise((r) => setTimeout(r, 5));
  await addJob(db, { id: "g", title: "Contador de costos" });
  await matchAll(db, approveAll);
  const calls: Array<{ template: boolean }> = [];
  const closed: Sender = async (m) => {
    calls.push({ template: Boolean(m.template) });
    return m.template ? { status: 202, mode: "template" } : { status: 422, code: "outside_window" };
  };
  assert.equal((await notifyAll(db, closed)).template, 1);
  assert.deepEqual(calls, [{ template: false }, { template: true }]);
  assert.equal((await notifyAll(db, closed)).outside_window, 1);
  assert.equal(calls.filter((c) => c.template).length, 1);
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

    await tools.registrar_opinion({ phone, aviso_id: saved.avisos[0]!.id, util: true, postulo: true });
    await tools.registrar_opinion({ phone, aviso_id: saved.avisos[1]!.id, util: false, motivo: "pedían inglés" });
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

test("consola de admin: su propia clave, solo lectura, sin teléfonos, y cada llamada queda registrada", async () => {
  const db = openDb(":memory:");
  await addJob(db, { id: "a", title: "Contador general" });
  const server = createApp(db, fakeEmbed, "clave-backend", null, "clave-admin").listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, key: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  try {
    const phone = "+56948454110";
    assert.equal((await call("/tools/guardar_preferencias", "clave-backend", { method: "POST", body: JSON.stringify({ phone, resumen: "contador" }) })).status, 200);
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
    assert.ok(!JSON.stringify([overview, users, detail]).includes("48454110"), "un teléfono completo salió de la consola");

    const log = await (await call("/admin/log?limit=50", "clave-admin")).json();
    const tool = log.find((l: any) => l.path === "/tools/guardar_preferencias");
    assert.equal(tool.caller, "backend");
    assert.equal(tool.status, 200);
    assert.equal(tool.phone_id, phoneId(phone));
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
