# Luna + Grupo de Supervisores (Baileys) — v1.3

- Reenvía consultas al **grupo** `SUPERVISOR_GROUP` para evitar duplicados.
- Toma la **primera** respuesta en 60s y responde al cliente; extras → **nota privada**.
- Aprende (`learned.json`) con TTL. Comando `+expiro` para invalidar respuestas.

## Pasos
1) `cp .env.example .env` y completa `CHATWOOT_*` y `SUPERVISOR_GROUP` (o `SUPERVISOR_GROUP_LINK`).
2) `npm i`
3) `node app.js`
4) Escaneá `http://localhost:3000/qr.svg`.

Endpoints:
- `/chatwoot/bot` y `/chatwoot/webhook`
