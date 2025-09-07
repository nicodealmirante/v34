\
// app.js — Sales Bot v3: Chatwoot + Supervisores múltiples + Adjuntos 2‑vías (WhatsApp Cloud)
// Node 18/20+ (fetch/FormData/Blob nativos)
import 'dotenv/config'
import express from 'express'
import crypto from 'crypto'
import fs from 'fs'

const app = express()
app.use(express.json({ limit: '10mb' }))

const {
  CHATWOOT_URL,
  CHATWOOT_ACCOUNT_ID,
  CHATWOOT_API_TOKEN,
  WEBHOOK_SECRET,
  // WhatsApp Cloud API
  WABA_PHONE_ID,
  WABA_TOKEN,
  WABA_VERIFY_TOKEN,
  // Varios supervisores separados por coma. Ej: "5491172284607,5491122334455"
  SUPERVISORS = '',
  BRAND_NAME = 'Selfie Mirror'
} = process.env

if (!CHATWOOT_URL || !CHATWOOT_ACCOUNT_ID || !CHATWOOT_API_TOKEN) {
  console.error('Faltan variables CHATWOOT_* en .env')
  process.exit(1)
}

function onlyDigits(s) { return (s || '').replace(/\D+/g,'') }
const SUPS = new Set( SUPERVISORS.split(',').map(s => onlyDigits(s)).filter(Boolean) )

// ===== Chatwoot helpers
const hmacOk = (raw, sig) => {
  if (!WEBHOOK_SECRET) return true
  if (!sig) return false
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(sig))
}
const CW_MSG_URL = (conversationId) =>
  `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`

async function cwReplyText(conversationId, content) {
  const r = await fetch(CW_MSG_URL(conversationId), {
    method: 'POST',
    headers: { 'api_access_token': CHATWOOT_API_TOKEN },
    body: formDataFrom({ content }) // usar multipart por compat con adjuntos
  })
  if (!r.ok) throw new Error('Chatwoot text error: ' + await r.text())
}

function formDataFrom(fields) {
  const fd = new FormData()
  for (const [k,v] of Object.entries(fields||{})) {
    if (v === undefined || v === null) continue
    fd.append(k, typeof v === 'string' ? v : JSON.stringify(v))
  }
  return fd
}

// Subir adjunto binario a Chatwoot
async function cwReplyAttachment(conversationId, { buffer, filename, mime, caption }) {
  const fd = new FormData()
  if (caption) fd.append('content', caption)
  fd.append('attachments[]', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename || 'file')
  const r = await fetch(CW_MSG_URL(conversationId), {
    method: 'POST',
    headers: { 'api_access_token': CHATWOOT_API_TOKEN },
    body: fd
  })
  if (!r.ok) throw new Error('Chatwoot attach error: ' + await r.text())
}

// ===== KB simple (ventas)
let KB = []
const KB_PATH = new URL('./knowledge.json', import.meta.url).pathname
function loadKB() { try { KB = JSON.parse(fs.readFileSync(KB_PATH,'utf-8')) } catch { KB = [] } }
loadKB()

function normalize(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .replace(/[^a-z0-9\s]/g,' ')
    .replace(/\s+/g,' ').trim()
}
function tokenSet(str) { return new Set(normalize(str).split(' ').filter(Boolean)) }
function jaccard(a,b){ const A=tokenSet(a),B=tokenSet(b); const inter=[...A].filter(x=>B.has(x)).length; const uni=new Set([...A,...B]).size||1; return inter/uni }
function findBestAnswer(userText) {
  const t = userText || ''
  const n = normalize(t)
  let best = { score: 0, answer: null }
  for (const item of KB) {
    let m = 0
    if (Array.isArray(item.patterns)) {
      for (const rx of item.patterns) { try { if (new RegExp(rx, 'i').test(t)) m = Math.max(m, 0.9) } catch {} }
    }
    if (item.q) m = Math.max(m, jaccard(n, item.q))
    if (m > best.score) best = { score: m, answer: item.a }
  }
  return best
}

// ===== WhatsApp Cloud helpers
const WABA_BASE = `https://graph.facebook.com/v21.0`
const WABA_MSG_URL = `${WABA_BASE}/${WABA_PHONE_ID}/messages`

async function wabaSendText(toDigits, body) {
  if (!WABA_PHONE_ID || !WABA_TOKEN) return false
  const r = await fetch(WABA_MSG_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WABA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product:'whatsapp', to: toDigits, type:'text', text:{ body } })
  })
  return r.ok
}

// Enviar media por **link** (más simple que subir id)
async function wabaSendMediaLink(toDigits, kind, link, caption) {
  if (!WABA_PHONE_ID || !WABA_TOKEN) return false
  const payload = { messaging_product:'whatsapp', to: toDigits, type: kind }
  payload[kind] = { link }
  if (caption && (kind==='image' || kind==='video' || kind==='document')) payload[kind].caption = caption
  const r = await fetch(WABA_MSG_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WABA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  if (!r.ok) console.error('WABA media link error:', await r.text())
  return r.ok
}

// Descargar media recibido desde WABA (id -> url -> binario)
async function wabaDownloadMedia(mediaId) {
  const meta1 = await fetch(`${WABA_BASE}/${mediaId}`, { headers: { 'Authorization': `Bearer ${WABA_TOKEN}` } })
  if (!meta1.ok) throw new Error('WABA media meta error')
  const meta = await meta1.json()
  const url = meta.url
  const blob = await (await fetch(url, { headers: { 'Authorization': `Bearer ${WABA_TOKEN}` } })).blob()
  const arrayBuffer = await blob.arrayBuffer()
  return { buffer: Buffer.from(arrayBuffer), mime: blob.type || 'application/octet-stream', filename: meta?.file_name || `waba_${mediaId}` }
}

// Track último conversationId por supervisor
const lastConvBySupervisor = new Map()

function tagForConv(conversationId){ return `[#CW${conversationId}]` }
function extractTaggedConvId(text){ const m = (text||'').match(/\[#CW(\d+)\]/); return m?.[1] }

// ===== Chatwoot webhook (cliente → bot)
app.post('/webhook', async (req, res) => {
  const raw = JSON.stringify(req.body)
  const sig = req.headers['x-chatwoot-signature']
  if (!hmacOk(raw, sig)) return res.status(401).end()
  res.status(200).end()

  const ev = req.body
  const isIncoming = ev?.event === 'message_created' && ev?.message_type === 'incoming'
  const conversationId = ev?.conversation?.id || ev?.message?.conversation_id
  if (!isIncoming || !conversationId) return

  const text = ev?.content || ''
  const attachments = ev?.attachments || []

  try {
    // 1) Probar KB
    const { score, answer } = findBestAnswer(text)
    if (score >= 0.35 && answer) {
      await cwReplyText(conversationId, answer)
      return
    }

    // 2) Avisar al cliente y enviar consulta + adjuntos al/los supervisores
    await cwReplyText(conversationId, 'Estoy consultando con el equipo y te respondo enseguida.')

    const token = tagForConv(conversationId)
    const question = (text && text.trim().length) ? text : '(mensaje sin texto)'
    const header = `Consulta de ventas (${BRAND_NAME}) ${token}\nPregunta: ${question}`

    for (const sup of SUPS) {
      if (sup) {
        await wabaSendText(sup, header)
        // reenviar adjuntos del cliente al supervisor por **link** si Chatwoot nos da data_url/file_url
        for (const a of attachments) {
          const link = a?.data_url || a?.file_url || a?.thumb_url
          if (!link) continue
          const mime = (a?.file_type || '').toLowerCase()
          let kind = null
          if (mime.startsWith('image/')) kind = 'image'
          else if (mime.startsWith('video/')) kind = 'video'
          else if (mime.startsWith('audio/')) kind = 'audio'
          else kind = 'document'
          await wabaSendMediaLink(sup, kind, link, a?.fallback_title || a?.file_name || '')
        }
      }
      if (sup) lastConvBySupervisor.set(sup, String(conversationId))
    }
  } catch (e) {
    console.error(e)
    await cwReplyText(conversationId, 'Se me complicó procesar eso. ¿Lo repetís breve?')
  }
})

// ===== WABA webhook (supervisor → bot → Chatwoot)
app.get('/waba', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && token && token === WABA_VERIFY_TOKEN) return res.status(200).send(challenge)
  return res.status(403).send('forbidden')
})

app.post('/waba', async (req, res) => {
  res.sendStatus(200)
  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value
    const messages = entry?.messages || []
    for (const m of messages) {
      const fromDigits = onlyDigits(m.from)
      // filtrar solo supervisores configurados
      if (!SUPS.has(fromDigits)) continue

      // elegir conversación destino
      const textBody = m.text?.body || ''
      let convId = extractTaggedConvId(textBody) || lastConvBySupervisor.get(fromDigits)
      if (!convId) continue

      // Texto
      if (textBody) {
        const clean = textBody.replace(/\s*\[#CW\d+\]\s*/,'').trim()
        if (clean) await cwReplyText(convId, `👤 Supervisor: ${clean}`)
      }

      // Media
      const type = m.type
      if (type === 'image' || type === 'video' || type === 'audio' || type === 'document' || type === 'sticker') {
        const mediaId = m[type]?.id
        if (mediaId) {
          try {
            const media = await wabaDownloadMedia(mediaId)
            const caption = m[type]?.caption || ''
            await cwReplyAttachment(convId, { ...media, caption })
          } catch (e) {
            await cwReplyText(convId, `👤 Supervisor envió un adjunto, pero no pude descargarlo (${e.message}).`)
          }
        }
      }

      // update last conversation for that supervisor
      lastConvBySupervisor.set(fromDigits, String(convId))
    }
  } catch (e) {
    console.error('WABA inbound error:', e.message)
  }
})

app.get('/health', (_, res) => res.json({ ok: true, supervisors: [...SUPS] }))

const port = process.env.PORT || 8080
app.listen(port, () => console.log('Sales Bot v3 listo en :' + port))
