# Sales Bot v3 — Multi‑supervisor + Adjuntos 2‑vías

✅ Responde ventas desde `knowledge.json`.

✅ Si no sabe, consulta a **todos** los `SUPERVISORS` vía WhatsApp (Cloud API) con etiqueta `[#CW<conversationId>]`.

✅ Los supervisores responden por WhatsApp (texto y **adjuntos**), y el bot los publica en la conversación de **Chatwoot**.

✅ Si el cliente manda **adjuntos** en Chatwoot, se reenvían al supervisor por **link**.


## Setup
1) `.env` con `CHATWOOT_*`, `WABA_*`, y `SUPERVISORS` (comma‑separated, sin +).

2) Meta → Webhook de WhatsApp Cloud:

   - Callback: `https://TU_HOST/waba`

   - Verify token: `WABA_VERIFY_TOKEN`

   - Eventos: **messages**

3) Chatwoot → Webhooks

   - URL: `https://TU_HOST/webhook`

   - Evento: **message_created**

4) `npm i && node app.js` (o Docker).


## Notas técnicas
- Envío al supervisor: texto (`/messages` type=`text`) y media por **link** (image/video/audio/document). Ver WhatsApp Cloud docs.

- Descarga de media entrante del supervisor: media **id → url → binario** y subida a Chatwoot como `attachments[]` en **multipart/form-data**.

- El bot enruta por etiqueta `[#CWid]` o por la **última conversación pendiente** de ese número.

- Ajustá `knowledge.json` con tu info real (precio, seña, entrega, etc.).


Listo para producción básica. 🚀
