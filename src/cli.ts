import { config } from "./config.ts";
import { runCycle, sources } from "./cycle.ts";
import { openDb } from "./db.ts";
import { localEmbedder } from "./embed.ts";
import { ingest } from "./ingest.ts";

const db = openDb(config.dbPath);
const cmd = process.argv[2];
if (cmd === "ingest") console.log(JSON.stringify(await ingest(db, localEmbedder, sources()), null, 2));
else if (cmd === "run") console.log(JSON.stringify(await runCycle(db, localEmbedder), null, 2));
else {
  console.error("uso: node src/cli.ts ingest|run");
  process.exit(1);
}
