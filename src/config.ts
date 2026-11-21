const env = process.env;
const int = (v: string | undefined, d: number) => (v ? Number.parseInt(v, 10) : d);

export const config = {
  port: int(env.PORT, 8787),
  backendApiKey: env.BACKEND_API_KEY ?? "",
  dbPath: env.DB_PATH ?? "data/pega.db",
  vatio: {
    baseUrl: env.VATIO_BASE_URL ?? "https://vatio.ai",
    workspace: env.VATIO_WORKSPACE ?? "pega",
    serverKey: env.VATIO_SERVER_KEY ?? "",
    template: env.VATIO_TEMPLATE ?? "nuevos_avisos",
  },
  llm: {
    baseUrl: env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey: env.LLM_API_KEY ?? "",
    model: env.LLM_MODEL ?? "anthropic/claude-haiku-5.5",
  },
  ingestEveryMinutes: int(env.INGEST_EVERY_MINUTES, 60),
  /** Sitios Jobint a recorrer (claves de JOBINT_SITES). */
  jobintSites: (env.JOBINT_SITES ?? "laborum,bumeran-ar,bumeran-mx,bumeran-pe,multitrabajos,konzerta,bumeran-ve")
    .split(",").map((s) => s.trim()).filter(Boolean),
  jobintMaxPages: int(env.JOBINT_MAX_PAGES, 5),
  /** Sitios Computrabajo a recorrer (claves de COMPUTRABAJO_SITES). */
  computrabajoSites: (env.COMPUTRABAJO_SITES ?? "computrabajo-co").split(",").map((s) => s.trim()).filter(Boolean),
  /** Páginas de 20 avisos por región en cada corrida. */
  computrabajoMaxPages: int(env.COMPUTRABAJO_MAX_PAGES, 3),
  trabajandoMaxPages: int(env.TRABAJANDO_MAX_PAGES, 20),
  /** Avisos que se evalúan con el modelo por usuario en cada corrida. */
  candidatesPerUser: 8,
  /** Avisos que se mandan como máximo en un mensaje. */
  maxJobsPerMessage: 5,
  /** Días que un aviso se conserva y aparece en búsquedas. */
  jobRetentionDays: 45,
};
