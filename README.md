# pega

Un agente que busca trabajo por ti, por WhatsApp. La persona le cuenta a un agente (Vatio) qué busca;
este servicio trae cada hora los avisos nuevos de los portales, los cruza con cada persona y manda los que
le sirven con el link para postular.

| País | Portal |
|---|---|
| Chile | Laborum, Trabajando |
| Argentina, México, Perú, Venezuela | Bumeran |
| Ecuador | Multitrabajos |
| Panamá | Konzerta |
| Los 17 países (Argentina, Bolivia, Chile, Colombia, Costa Rica, Ecuador, El Salvador, Guatemala, Honduras, México, Nicaragua, Panamá, Paraguay, Perú, República Dominicana, Uruguay, Venezuela) | Computrabajo |

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
- **Match** (`src/match.ts`, `src/llm.ts`): por persona, filtros duros (país, región, modalidad, sueldo, exclusiones),
  los 8 avisos nuevos más parecidos por embedding y un modelo que decide cuáles valen un mensaje.
- **Envío** (`src/notify.ts`): por la API de servidor de Vatio. Con la ventana de 24 h abierta va el texto;
  cerrada, una plantilla como máximo al día y los avisos esperan a que la persona responda.
- **Herramientas del agente** (`src/tools.ts`, `vatio/tools`): `POST /tools/<nombre>` con Bearer `BACKEND_API_KEY`.

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
