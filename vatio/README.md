# El agente en Vatio

Vatio guarda el agente; estos archivos son la fuente para crearlo o recrearlo por el MCP.

1. `create_workspace` con el slug elegido (no se puede cambiar después).
2. `update_agent` con `instructions.md` y `personality.md`.
3. `set_secret` `CHAMBEANDO_API` (URL pública del backend) y `CHAMBEANDO_API_KEY` (el `BACKEND_API_KEY` del backend).
4. `set_backend`: base_url `$env.CHAMBEANDO_API`, headers `Authorization: Bearer $env.CHAMBEANDO_API_KEY`.
5. `set_tool` con cada archivo de `tools/`.
6. `create_whatsapp_template` (categoría utility, idioma `es`), nombre `nuevos_avisos`:
   - body: `Encontré chambas nuevas para ti: {{1}}. La más cercana a lo que buscas: {{2}}. ¿Te las mando?`
   - ejemplos: `3`, `Practicante de diseño gráfico`
   - botones quick_reply: `Ver avisos`, `Pausar avisos`
7. Conectar el número de WhatsApp y crear la clave secreta `vsk_live_…` en la bandeja (el MCP no la crea);
   va en `VATIO_SERVER_KEY` del backend.
