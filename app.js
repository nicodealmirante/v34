\
// app.js — Sales Bot v4: Chatwoot + Supervisores (Baileys) + Adjuntos 2‑vías + QR
// Node 18/20+
// - Webhook Chatwoot (ventas contra KB).
// - Si no sabe responder → consulta a supervisores vía **Baileys**.
// - Supervisores responden por WhatsApp y el bot publica en la conversación de Chatwoot.
// - Adjuntos 2‑vías (cliente→supervisor y supervisor→Chatwoot).
// - Emparejamiento QR: /qr.svg y /qr.png
import 'dotenv/config'
import express from 'express'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import mime from 'mime-types'
import QRCode from 'qrcode'
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadContentFromMessage
} from '@whiskeysockets/baileys'

const app = express()
app.use(express.json({ limit: '12mb' }))

const {
  CHATWOOT_URL,
  CHATWOOT_ACCOUNT_ID,
  CHATWOOT_API_TOKEN,
  WEBHOOK_SECRET,
  // Supervisores Baileys (coma, sin +, solo dígitos)
  SUPERVISORS = '',
  BRAND_NAME = 'Selfie Mirror'
} = process.env

if (!CHATWOOT_URL || !CHATWOOT_ACCOUNT_ID || !CHATWOOT_API_TOKEN) {
  console.error('Faltan variables CHATWOOT_* en .env')
  process.exit(1)
}

function onlyDigits (s) { return (s || '').replace(/\D+/g,'') }
const SUPS = new Set( SUPERVISORS.split(',').map(s => onlyDigits(s)).filter(Boolean) )

/* ================== Chatwoot helpers ================== */
const hmacOk = (raw, sig) => {
  if (!WEBHOOK_SECRET) return true
  if (!sig) return false
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(sig))
}
const CW_MSG_URL = (conversationId) =>
  `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`

function formDataFrom(fields) {
  const fd = new FormData()
  for (const [k,v] of Object.entries(fields||{})) {
    if (v === undefined || v === null) continue
    fd.append(k, typeof v === 'string' ? v : JSON.stringify(v))
  }
  return fd
}

async function cwReplyText(conversationId, content) {
  const r = await fetch(CW_MSG_URL(conversationId), {
    method: 'POST',
    headers: { 'api_access_token': CHATWOOT_API_TOKEN },
    body: formDataFrom({ content })
  })
  if (!r.ok) throw new Error('Chatwoot text error: ' + await r.text())
}

async function cwReplyAttachment(conversationId, { buffer, filename, mimeType, caption }) {
  const fd = new FormData()
  if (caption) fd.append('content', caption)
  const blob = new Blob([buffer], { type: mimeType || 'application/octet-stream' })
  fd.append('attachments[]', blob, filename || 'file')
  const r = await fetch(CW_MSG_URL(conversationId), {
    method: 'POST',
    headers: { 'api_access_token': CHATWOOT_API_TOKEN },
    body: fd
  })
  if (!r.ok) throw new Error('Chatwoot attach error: ' + await r.text())
}

/* ================== KB simple ventas ================== */
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

/* ================== Baileys (WhatsApp) ================== */
let sock = null
let lastQR = null
const lastConvBySupervisor = new Map() // digits -> conversationId

function jidFromDigits(d){ return `${d}@s.whatsapp.net` }

async function startSock () {
  const { state, saveCreds } = await useMultiFileAuthState('./auth')
  const { version } = await fetchLatestBaileysVersion()
  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['SalesBot','Chrome','1.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) {
      lastQR = {
        svg: await QRCode.toString(qr, { type: 'svg' }),
        png: await QRCode.toDataURL(qr, { margin: 1 })
      }
    }
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) setTimeout(startSock, 3000)
    }
  })

  // Inbound messages (supervisores → Chatwoot)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const m of messages) {
      try {
        const from = m.key?.remoteJid || ''
        const digits = onlyDigits(from)
        if (!SUPS.has(digits)) continue // solo supervisores

        // Texto / captions
        const txt = (
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          m.message?.videoMessage?.caption ||
          ''
        )

        // Resolver conversación objetivo
        const tokenMatch = txt.match(/\[#CW(\d+)\]/)
        let convId = tokenMatch?.[1] || lastConvBySupervisor.get(digits)
        if (!convId) continue

        // Publicar texto
        const clean = txt.replace(/\s*\[#CW\d+\]\s*/,'').trim()
        if (clean) await cwReplyText(convId, `👤 Supervisor: ${clean}`)

        // Adjuntos (descargar y subir a Chatwoot)
        const mm = m.message
        const types = ['imageMessage','videoMessage','documentMessage','audioMessage','stickerMessage']
        for (const t of types) {
          if (!mm?.[t]) continue
          const kind = t.replace('Message','')
          const stream = await downloadContentFromMessage(mm[t], kind.startsWith('image') ? 'image' :
                                                               kind.startsWith('video') ? 'video' :
                                                               kind.startsWith('audio') ? 'audio' : 'document')
          let buf = Buffer.from([])
          for await (const chunk of stream) buf = Buffer.concat([buf, chunk])
          const caption = mm[t]?.caption || ''
          const mimetype = mm[t]?.mimetype || 'application/octet-stream'
          const filename = mm[t]?.fileName || `wa_${Date.now()}`
          await cwReplyAttachment(convId, { buffer: buf, filename, mimeType: mimetype, caption })
        }

        lastConvBySupervisor.set(digits, String(convId))
      } catch (e) {
        console.error('Baileys upsert error:', e.message)
      }
    }
  })
}

async function waSendText(toDigits, text){
  if (!sock) throw new Error('Baileys no inicializado')
  await sock.sendMessage(jidFromDigits(toDigits), { text })
}

async function fetchBuffer(url){
  const r = await fetch(url)
  if (!r.ok) throw new Error('Fetch media failed: ' + r.status)
  const arr = await r.arrayBuffer()
  const ct = r.headers.get('content-type') || 'application/octet-stream'
  let filename = path.basename(new URL(url).pathname || 'file')
  if (!filename.includes('.')) {
    const ext = mime.extension(ct) || 'bin'
    filename = filename + '.' + ext
  }
  return { buffer: Buffer.from(arr), mimeType: ct, filename }
}

async function waSendMediaFromUrl(toDigits, link, caption){
  const { buffer, mimeType, filename } = await fetchBuffer(link)
  const jid = jidFromDigits(toDigits)
  if (mimeType.startsWith('image/')) {
    await sock.sendMessage(jid, { image: buffer, caption })
  } else if (mimeType.startsWith('video/')) {
    await sock.sendMessage(jid, { video: buffer, caption })
  } else if (mimeType.startsWith('audio/')) {
    await sock.sendMessage(jid, { audio: buffer, mimetype: mimeType, ptt: false })
  } else {
    await sock.sendMessage(jid, { document: buffer, fileName: filename, mimetype: mimeType, caption })
  }
}

/* ================== Chatwoot Webhook ================== */
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
    // 1) Intento KB
    const { score, answer } = findBestAnswer(text)
    if (score >= 0.35 && answer) {
      await cwReplyText(conversationId, answer)
      return
    }

    // 2) Aviso + envío a supervisores por Baileys
    await cwReplyText(conversationId, 'Estoy consultando con el equipo y te respondo enseguida.')

    const token = `[#CW${conversationId}]`
    const header = `Consulta de ventas (${BRAND_NAME}) ${token}\nPregunta: ${text && text.trim().length ? text : '(mensaje sin texto)'}`
    for (const sup of SUPS) {
      if (!sup) continue
      await waSendText(sup, header)
      // reenviar adjuntos por URL → buffer
      for (const a of attachments) {
        const link = a?.data_url || a?.file_url || a?.thumb_url
        if (!link) continue
        const caption = a?.fallback_title || a?.file_name || ''
        await waSendMediaFromUrl(sup, link, caption)
      }
      lastConvBySupervisor.set(sup, String(conversationId))
    }
  } catch (e) {
    console.error(e)
    await cwReplyText(conversationId, 'Se me complicó procesar eso. ¿Lo repetís breve?')
  }
})

/* ================== QR endpoints ================== */
app.get('/qr.svg', (req, res) => {
  if (!lastQR?.svg) return res.status(404).send('QR no disponible. Esperando conexión...')
  res.setHeader('Content-Type', 'image/svg+xml')
  res.send(lastQR.svg)
})
app.get('/qr.png', (req, res) => {
  if (!lastQR?.png) return res.status(404).send('QR no disponible. Esperando conexión...')
  const b64 = lastQR.png.split(',')[1]
  const buf = Buffer.from(b64, 'base64')
  res.setHeader('Content-Type', 'image/png')
  res.send(buf)
})

/* ================== Health ================== */
app.get('/health', (_, res) => res.json({ ok: true, supervisors: [...SUPS], baileys: !!sock }))

/* ================== Boot ================== */
const port = process.env.PORT || 8080
app.listen(port, () => console.log('Sales Bot v4 (Baileys) listo en :' + port))
startSock().catch(e => console.error('Baileys init error:', e))
