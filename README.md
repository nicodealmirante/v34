# Sales Bot v4 — Baileys (Supervisor por WhatsApp) + Adjuntos 2‑vías + QR

## Qué hace
- Responde ventas desde `knowledge.json`.
- Si no sabe, **consulta a supervisores** vía **Baileys**.
- Los supervisores responden por WhatsApp y el bot publica en **Chatwoot**.
- Soporta **adjuntos 2‑vías** (cliente ↔ supervisor).
- Emparejamiento por **QR** en `/qr.svg` o `/qr.png`.

## Arranque
1) `cp .env.example .env` y completá `CHATWOOT_*` y `SUPERVISORS` (sin +).
2) `npm i`
3) `node app.js`
4) Abrí `http://localhost:8080/qr.svg` para escanear el QR y vincular.
5) En Chatwoot → Webhooks:
   - URL: `http://TU_HOST:8080/webhook`
   - Evento: **message_created**
   - (Opcional) firma con `WEBHOOK_SECRET`.

## Flujo
- El bot busca respuesta en KB (regex + similitud). Umbral 0.35.
- Si no hay match: avisa en Chatwoot y envía mensaje a TODOS los `SUPERVISORS` con etiqueta `[#CW<conversationId>]`.
- Cuando el supervisor escribe (o envía media), el bot inyecta en la conversación correspondiente.
  - Si el texto contiene `[#CWid]` se enruta a ese id.
  - Si no, se enruta a la **última conversación pendiente** de ese supervisor.

## Adjuntos
- Cliente → Supervisor: el bot toma `data_url/file_url` del webhook y los reenvía descargando el archivo y mandándolo por Baileys.
- Supervisor → Chatwoot: el bot descarga con `downloadContentFromMessage` y sube como `attachments[]` (multipart).

## Persistencia
- Baileys usa `./auth/` (multi-file). **Montá volumen** si usás Docker.

## Docker
```bash
docker build -t sales-bot-v4 .
docker run -p 8080:8080 -v $(pwd)/auth:/app/auth --env-file .env sales-bot-v4
```

Listo para iterar. 🚀
