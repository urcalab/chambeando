import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { personalize } from "./src/index.js";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const order = (h) => [...h.matchAll(/<tr data-country="(\w+)">/g)].map((m) => m[1]);

test("la portada pone primero el país del visitante y usa su ciudad", () => {
  assert.deepEqual(order(html), ["CL", "MX", "PE", "CO"]);
  const pe = personalize(html, "PE");
  assert.deepEqual(order(pe), ["PE", "CL", "MX", "CO"]);
  assert.match(pe, /<span data-geo="city">Lima<\/span>/);
  assert.match(pe, /<span data-geo="place">Miraflores, Lima<\/span>/);
  assert.match(pe, /<b data-geo="price">S\/ 16\.90<\/b>/);
  assert.match(personalize(html, "CL"), /<b data-geo="price">\$4\.990<\/b>/);
  assert.match(html, /<b data-geo="price">USD 5<\/b>/);
  assert.match(personalize(html, "CO"), /<b data-geo="price">\$16\.900 COP<\/b>/);
  assert.match(personalize(html, "MX"), /<b data-geo="price">\$99 MXN<\/b>/);
  assert.equal(personalize(html, "CL").length > 0, true);
  assert.deepEqual(order(personalize(html, "CO")), ["CO", "CL", "MX", "PE"]);
});

test("un país sin servicio recibe la página sin cambios", () => {
  assert.equal(personalize(html, "AR"), html);
  assert.equal(personalize(html, ""), html);
});
