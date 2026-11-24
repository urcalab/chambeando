# Computrabajo: estado y salidas

Última actualización: 24-11-2026.

## Qué pasa

Computrabajo responde **403** a todas las consultas que salen del droplet de producción, en los cuatro países
abiertos (Chile, México, Perú y Colombia). Desde otras redes, las mismas páginas responden 200. Es un bloqueo por la
IP o la red del servidor (DigitalOcean), no un cambio en su HTML.

- Desde el primer despliegue (21-11-2026) nunca entró un aviso de Computrabajo en producción. El registro de corridas
  (`ingest_runs`) lo muestra desde el 23-11-2026, cuando se agregó.
- Es la fuente más grande en los cuatro países y la única de Colombia. Sin ella, Colombia no tiene avisos, y Chile,
  México y Perú tienen solo lo de Laborum, Bumeran y Trabajando (unos 3.900 avisos únicos el 24-11-2026).
- La tabla de fuentes de la landing todavía muestra las cifras que declara Computrabajo.

## Qué hace hoy el backend

- **Ritmo lento:** una sola página por región, 1,5 s entre avisos y 3 s entre páginas (`src/sources/computrabajo.ts`).
  La primera corrida pidió cerca de 2.000 páginas seguidas; el bloqueo pudo venir de esa ráfaga.
- **Descanso de 24 horas:** una fuente que responde 403 o 429 no se vuelve a pedir hasta 24 horas después de su último
  intento (`restingSources` en `src/cycle.ts`, `BLOCKED_SOURCE_BACKOFF_HOURS`). Si al reintentar responde bien, sigue
  con el ritmo normal.

**Cómo saber si volvió:** en el dashboard de admin, tabla Fuentes, o en `GET /admin/runs`. Mientras descansa, la fuente
aparece con `skipped: "bloqueada (403/429); se reintenta después de …"`; si vuelve, aparece con `added` mayor que cero.

## Decisión

No se usan proxies, IPs residenciales ni cambios de servidor para que Computrabajo no reconozca las consultas.
El bloqueo es una decisión del portal, y saltárselo puede leerse como acceso no autorizado y rompe sus términos.
Para un proyecto público, con el nombre de Urcalab y Vatio, el riesgo no compensa.

## Salidas

1. **Que el bloqueo sea temporal.** Esperar los reintentos de 24 horas con el ritmo lento.
2. **Acceso autorizado.** Pedirle a Redarbor (dueña de Computrabajo) un feed o una API para socios, con atribución
   visible. Argumento: les mandamos postulantes sin costo y podemos compartir métricas de clics y postulaciones.

   > **Asunto:** Acceso a avisos de Computrabajo para Chambeando (agente de empleo gratuito)
   >
   > Hola, soy Iván Wolf, de Urcalab (Chile). Hicimos Chambeando (chambeando.urcalab.com), un agente de WhatsApp
   > gratuito que ayuda a jóvenes de Chile, México, Perú y Colombia a encontrar su primer trabajo, práctica o
   > part-time. Cuando aparece un aviso que le sirve a alguien, le mandamos el link al aviso original para que postule
   > en el portal: no publicamos avisos propios ni nos quedamos con la postulación.
   >
   > Nos gustaría incluir los avisos de Computrabajo de forma autorizada, con un feed, una API para socios o las
   > condiciones que ustedes definan, y con atribución visible a Computrabajo. Les enviaríamos postulantes calificados
   > sin costo y podemos compartirles métricas de clics y postulaciones.
   >
   > ¿Con quién puedo conversarlo?
   >
   > Saludos,
   > Iván Wolf — ivan@urcalab.com

   Estado: sin enviar.

3. **Otras fuentes para Colombia.** Lo revisado hasta ahora, de lo más a lo menos viable:

   | Fuente | Qué se vio | Viable |
   |---|---|---|
   | Get on Board | API pública y documentada; unos 33 avisos de Colombia, casi todos de tecnología y senior | Sí, pero aporta poco |
   | Servicio Público de Empleo (SPE) | Portal estatal de empleo de Colombia | Sin revisar |
   | elempleo.com | Responde con un desafío anti-bots | No, por la misma razón que Computrabajo |
   | Magneto365 | `robots.txt` prohíbe todo | No |
   | Indeed, OCC | Página de verificación de seguridad | No |
   | Bumeran / Jobint | No opera en Colombia | No |

## Pendientes

- [ ] Enviar el correo a Redarbor y anotar la respuesta aquí.
- [ ] Revisar el Servicio Público de Empleo de Colombia: si tiene datos abiertos o una API.
- [ ] Actualizar la tabla de fuentes de la landing según cómo quede Computrabajo.
