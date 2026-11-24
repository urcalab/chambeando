const env = process.env;
const int = (v: string | undefined, d: number) => (v ? Number.parseInt(v, 10) : d);

export const config = {
  port: int(env.PORT, 8787),
  backendApiKey: env.BACKEND_API_KEY ?? "",
  /** Clave de la consola de admin (/admin/*). Vacía: la consola queda apagada. */
  adminApiKey: env.ADMIN_API_KEY ?? "",
  /** Días que se guarda el registro de llamadas a la API. */
  apiLogRetentionDays: Number.parseInt(env.API_LOG_RETENTION_DAYS ?? "180", 10),
  /** URL pública del backend, sin "/" final. Con ella los links a avisos pasan por /r/<token> para contar clics. */
  publicUrl: (env.PUBLIC_URL ?? "").replace(/\/+$/, ""),
  dbPath: env.DB_PATH ?? "data/chambeando.db",
  vatio: {
    baseUrl: env.VATIO_BASE_URL ?? "https://vatio.ai",
    workspace: env.VATIO_WORKSPACE ?? "chambeando",
    serverKey: env.VATIO_SERVER_KEY ?? "",
    template: env.VATIO_TEMPLATE ?? "nuevos_avisos",
  },
  llm: {
    baseUrl: env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey: env.LLM_API_KEY ?? "",
    model: env.LLM_MODEL ?? "anthropic/claude-haiku-5.5",
  },
  /** Intervalo de ingesta y recomendaciones automáticas. */
  ingestEveryMinutes: int(env.INGEST_EVERY_MINUTES, 60),
  /** Sitios Jobint a recorrer (claves de JOBINT_SITES). */
  jobintSites: (env.JOBINT_SITES ?? "laborum,bumeran-ar,bumeran-mx,bumeran-pe,multitrabajos,konzerta,bumeran-ve")
    .split(",").map((s) => s.trim()).filter(Boolean),
  jobintMaxPages: int(env.JOBINT_MAX_PAGES, 5),
  /** Sitios Computrabajo a recorrer ("computrabajo-mx,computrabajo-co"); sin definir, todos los países. */
  computrabajoSites: env.COMPUTRABAJO_SITES?.split(",").map((s) => s.trim()).filter(Boolean) ?? null,
  /** Páginas de 20 avisos por región en cada corrida. */
  computrabajoMaxPages: int(env.COMPUTRABAJO_MAX_PAGES, 1),
  /** Proxy HTTP(S) de salida exclusivo para Computrabajo. Vacío: conexión directa. */
  computrabajoProxyUrl: env.COMPUTRABAJO_PROXY_URL || undefined,
  /** Horas que se deja descansar una fuente que respondió 403 o 429 antes de volver a intentarlo. */
  blockedSourceBackoffHours: int(env.BLOCKED_SOURCE_BACKOFF_HOURS, 24),
  trabajandoMaxPages: int(env.TRABAJANDO_MAX_PAGES, 20),
  /** Avisos que se evalúan con el modelo por usuario en cada corrida. */
  candidatesPerUser: 8,
  /** Avisos que se mandan como máximo en un mensaje. */
  maxJobsPerMessage: 3,
  /** Mínimo entre dos mensajes automáticos a una misma persona. */
  minHoursBetweenMessages: 2,
  /** Horario en que se mandan mensajes automáticos, en la hora local del país de la persona: [desde, hasta). */
  sendHours: [8, 19] as [number, number],
  /** Días que un aviso se conserva y aparece en búsquedas. */
  jobRetentionDays: 45,
};
