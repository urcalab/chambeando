# El agente en Vatio

Vatio guarda el agente; estos archivos son la fuente para crearlo o recrearlo por el MCP.

1. `create_workspace` con el slug elegido (no se puede cambiar después).
2. `update_agent` con `instructions.md` y `personality.md`.
3. `set_secret` `PEGA_API` (URL pública del backend) y `PEGA_API_KEY` (el `BACKEND_API_KEY` del backend).
4. `set_backend`: base_url `$env.PEGA_API`, headers `Authorization: Bearer $env.PEGA_API_KEY`.
5. `set_tool` con cada archivo de `tools/`.
6. `create_whatsapp_template` (categoría utility, idioma `es`), nombre `nuevos_avisos`:
   - body: `Tenemos avisos de trabajo nuevos para ti: {{1}}. El más cercano a lo que buscas: {{2}}. ¿Te los mando?`
   - ejemplos: `3`, `Analista contable`
   - botones quick_reply: `Ver avisos`, `Pausar avisos`
7. Conectar el número de WhatsApp y crear la clave secreta `vsk_live_…` en la bandeja (el MCP no la crea);
   va en `VATIO_SERVER_KEY` del backend.
