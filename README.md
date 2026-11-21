# chambeando

Chambeando (chambeando.app): un agente que busca chamba por ti, por WhatsApp, pensado para quien busca su
primer trabajo, una práctica o algo part-time. La persona le cuenta a un agente (Vatio) qué estudia y qué busca;
este servicio trae cada hora los avisos nuevos de los portales, los cruza con cada persona y manda los que le
sirven con el link para postular.

El servicio está abierto en **Chile, México, Perú y Colombia** (variable `COUNTRIES`):

| País | Portales |
|---|---|
| Chile | Computrabajo, Laborum, Trabajando |
| México | Computrabajo, Bumeran |
| Perú | Computrabajo, Bumeran |
| Colombia | Computrabajo |

Los conectores ya cubren otros 13 países de Latinoamérica (Jobint en 7 y Computrabajo en 17); se abren
agregando su código a `COUNTRIES`. Mientras no estén ahí, no se traen sus avisos ni se aceptan sus números.

Laborum, Bumeran, Multitrabajos y Konzerta son la misma plataforma (Jobint) con otra marca: un solo conector,
`src/sources/jobint.ts`. Agregar un país de esa plataforma es una línea en `JOBINT_SITES`. El país de cada
persona sale del código de su número de WhatsApp.

Computrabajo (`src/sources/computrabajo.ts`) no tiene API: se lee el HTML del listado de cada región,
ordenado por fecha, y el detalle de cada aviso nuevo (JSON-LD, o el HTML si no lo trae). Es el conector más
frágil: si el portal cambia su HTML, la corrida lo informa como error de esa fuente. Solo recorre rutas que
su `robots.txt` permite. Los portales que prohíben el rastreo o lo bloquean no se incluyen. La lista de regiones por
país está en `src/sources/computrabajo-regions.json` y se regenera con `node scripts/computrabajo-regions.ts`.
La primera corrida trae solo la primera página de cada región (unos 20 avisos) y tarda cerca de una hora.

`node src/cli.ts counts` muestra cuántos avisos declara cada portal; de ahí sale la tabla de la landing.

## Cómo funciona

- **Ingest** (`src/sources`, `src/ingest.ts`): pagina por fecha las APIs JSON de los portales hasta
  encontrar avisos ya guardados. Cada aviso se guarda en SQLite con su embedding.
- **Match** (`src/match.ts`, `src/llm.ts`): por persona, filtros duros (país, región, tipo de trabajo, modalidad, sueldo, exclusiones),
  los 8 avisos nuevos más parecidos por embedding y un modelo que decide cuáles valen un mensaje.
- **Envío** (`src/notify.ts`): por la API de servidor de Vatio. Con la ventana de 24 h abierta va el texto;
  cerrada, una plantilla como máximo al día y los avisos esperan a que la persona responda.
- **Herramientas del agente** (`src/tools.ts`, `vatio/tools`): `POST /tools/<nombre>` con Bearer `BACKEND_API_KEY`.

## Duplicados

El mismo aviso puede estar en dos portales o republicarse con otro id. Al guardar, cada aviso recibe una
huella (`dedupeKey` en `src/ingest.ts`): país, cargo, empresa sin forma societaria y región; si la empresa
es confidencial, el comienzo de la descripción en su lugar. Dos avisos con la misma huella y una localidad en
común son el mismo: el primero queda como original y los demás se guardan con `duplicate_of`, sin embedding,
y nunca se ofrecen. La misma vacante en dos comunas distintas cuenta como dos avisos.

## Perfil de cada persona

El agente lo arma conversando y lo guarda con `guardar_preferencias`: qué busca, estudios, si es su primer
trabajo, tipo de trabajo (`practica`, `part_time`, `full_time`), cargos, región, modalidad, sueldo mínimo y
exclusiones. El tipo de trabajo es un filtro duro: se lee de la jornada del aviso y, para las prácticas, del
título (`jobKind` en `src/text.ts`). A quien busca su primer trabajo, el modelo le descarta los avisos que piden
más de un año de experiencia.

## Correr

    cp .env.example .env    # completar
    npm install
    node --env-file=.env src/server.ts   # servidor + corrida cada hora
    npm run ingest                       # solo traer avisos
    npm test

Node 22.18 o superior (TypeScript sin compilar, SQLite incluido). El modelo de embeddings se descarga de
Hugging Face la primera vez y usa unos 550 MB de RAM.

`GET /health` responde sin clave. `POST /run` fuerza una corrida.

## Landing

`site/index.html` es una página estática, sin build. El botón de WhatsApp se activa poniendo el número
del agente en `WHATSAPP_NUMBER`, al final del archivo; mientras esté vacío dice "Muy pronto".

## Despliegue

Corre en un droplet compartido, detrás de kamal-proxy y Cloudflare, en https://chambeando.urcalab.com.
`.github/workflows/deploy.yml` solo despliega, con Kamal, en cada push a main que toque el backend. Los tests corren
antes, en tu máquina: `npm install` activa el hook `.githooks/pre-push`, que corre `npm test` y frena el push si falla.
El único secreto del repositorio es `OP_SERVICE_ACCOUNT_TOKEN`: la clave SSH, los secretos de `.kamal/secrets` y
el token para pedir la IP del droplet a DigitalOcean (la IP no va en el repositorio) salen del vault
`DevOps Routines` de 1Password: `Droplet SSH`, `Docker Hub`, `Chambeano`, `OpenRouter` y `DigitalOcean`.

El contenedor tiene un tope de 1 GB de RAM. Con el modelo de embeddings cargado y una ingesta en curso usa
unos 780 MB.

Métricas de las recomendaciones: `GET /stats?days=7` (con la clave del backend) o `kamal stats`. Muestra
cuántos avisos se evaluaron, se mandaron, se abrieron, se calificaron y en cuántos postularon, por portal, y
los últimos motivos de "no me sirve". Los clics se cuentan porque cada link pasa por `/r/<token>`.

## Licencia

MIT. El agente corre sobre [Vatio](https://vatio.ai).
