
import express from 'express'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import QRCode from 'qrcode'
import mime from 'mime-types'
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadContentFromMessage
} from '@whiskeysockets/baileys'

const app = express()
app.use(express.json({ limit: '4mb' }))

const CW_URL   = process.env.CHATWOOT_URL
const CW_ACC   = process.env.CHATWOOT_ACCOUNT_ID
const CW_TOKEN = process.env.CHATWOOT_API_TOKEN
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''

const BRAND_NAME  = process.env.BRAND_NAME || 'Selfie Mirror'
const LUNA_NAME   = process.env.LUNA_NAME || 'Luna'

let SUPERVISOR_GROUP = (process.env.SUPERVISOR_GROUP || '').trim()
const SUPERVISOR_GROUP_LINK = (process.env.SUPERVISOR_GROUP_LINK || '').trim()

const DEFAULT_TTL_DAYS = Number(process.env.DEFAULT_TTL_DAYS || 180)
const PRICE_TTL_DAYS   = Number(process.env.PRICE_TTL_DAYS || 30)

if (!CW_URL || !CW_ACC || !CW_TOKEN) {
  throw new Error('Faltan ENV: CHATWOOT_URL, CHATWOOT_ACCOUNT_ID, CHATWOOT_API_TOKEN')
}
const CW_BASE = `${CW_URL}/api/v1/accounts/${CW_ACC}`

const stateFile = path.join(process.cwd(), 'state.json')
let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}
if (!state.__rr || typeof state.__rr.i !== 'number') state.__rr = { i:0 }

function touch(convId) {
  if (!state[convId]) state[convId] = {
    muted:false, greeted:false, lastTouch:Date.now(),
    lastAtajo: null,
    form: null,
    supActive: false,
    pendingQ: null,
    answeredAt: 0
  }
  state[convId].lastTouch = Date.now()
  return state[convId]
}
function saveState(){ fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)) }

const learnedFile = path.join(process.cwd(), 'learned.json')
let LEARNED = fs.existsSync(learnedFile) ? JSON.parse(fs.readFileSync(learnedFile, 'utf8')) : []
function saveLearned(){ fs.writeFileSync(learnedFile, JSON.stringify(LEARNED, null, 2)) }

const kbFile = path.join(process.cwd(), 'knowledge.json')
let KB = fs.existsSync(kbFile) ? JSON.parse(fs.readFileSync(kbFile, 'utf8')) : []

function norm(s=''){
  return String(s).toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s]/g,' ')
    .replace(/\s+/g, ' ').trim()
}
const wait = ms => new Promise(r => setTimeout(r, ms))

async function fetchWithRetry(url, opts={}, { retries=2, timeoutMs=15000 } = {}) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal })
    if (res.status >= 500 && retries > 0) {
      await wait((3 - retries) * 300)
      return fetchWithRetry(url, opts, { retries: retries - 1, timeoutMs })
    }
    return res
  } catch (e) {
    if (retries > 0) {
      await wait((3 - retries) * 300)
      return fetchWithRetry(url, opts, { retries: retries - 1, timeoutMs })
    }
    throw e
  } finally { clearTimeout(id) }
}
function filenameFromUrl(u='') {
  try { return decodeURIComponent(u.split('?')[0].split('/').pop() || 'file') }
  catch { return 'file' }
}
function fileKind(u='') {
  const x = (u || '').split('?')[0].toLowerCase()
  if (!x) return 'text'
  if (/\.(mp4|mov|webm|mkv)$/i.test(x)) return 'video'
  if (/\.pdf$/i.test(x)) return 'pdf'
  if (/\.webp$/i.test(x)) return 'sticker'
  if (/\.(png|jpe?g|gif)$/i.test(x)) return 'image'
  return 'text'
}

function tokenSet(str) { return new Set(norm(str).split(' ').filter(Boolean)) }
function jaccard(a,b){ const A=tokenSet(a),B=tokenSet(b); const inter=[...A].filter(x=>B.has(x)).length; const uni=new Set([...A,...B]).size||1; return inter/uni }

const DAY = 24*60*60*1000
function autoTtlDays(q, a){
  const s = `${q} ${a}`.toLowerCase()
  if (/\b(precio|usd|u\$d|dolar|dólar|\$|ars|cuota|financiaci[oó]n)\b/.test(s)) return PRICE_TTL_DAYS
  return DEFAULT_TTL_DAYS
}
function isExpired(entry){
  const now = Date.now()
  if (entry.expired === true) return true
  if (entry.expiresAt && now > Number(entry.expiresAt)) return true
  return false
}

function bestFromList(text, list) {
  let best = { score: 0, answer: null, source: null }
  const n = norm(text)
  for (const item of list) {
    if (item.expired || isExpired(item)) continue
    let m = 0
    if (Array.isArray(item.patterns)) {
      for (const rx of item.patterns) {
        try { if (new RegExp(rx, 'i').test(text)) m = Math.max(m, 0.9) } catch {}
      }
    }
    if (item.q) m = Math.max(m, jaccard(n, item.q))
    if (m > best.score) best = { score: m, answer: item.a, source: item.source || 'kb' }
  }
  return best
}
function findBestAnswer(text) {
  const learnedScored = LEARNED.map(e => ({ q: e.q, a: e.a, source: 'learned', expiresAt: e.expiresAt, expired: e.expired }))
  const A = bestFromList(text, learnedScored)
  if (A.score >= 0.58) return A
  const B = bestFromList(text, KB)
  if (B.score >= 0.35) return B
  return (A.score > B.score) ? A : B
}

async function cwPostJSON(url, body) {
  const r = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'api_access_token': CW_TOKEN },
    body: JSON.stringify(body || {})
  })
  const txt = await r.text()
  if (!r.ok) throw new Error(`Chatwoot ${r.status}: ${txt}`)
  return txt ? JSON.parse(txt) : {}
}

async function sendOutgoing(convId, text, attachments = []) {
  if (/\[#CW\d+\]/.test(text || '')) text = ''
  const url = `${CW_BASE}/conversations/${convId}/messages`
  const atts = Array.isArray(attachments) ? attachments : (attachments ? [attachments] : [])
  if (!atts.length) {
    if (!text) return {}
    return cwPostJSON(url, { content: text, message_type:'outgoing', private:false, content_type:'text' })
  }
  const max = 15 * 1024 * 1024
  const form = new FormData()
  form.append('content', text || '(adjunto)')
  form.append('message_type', 'outgoing')
  form.append('private', 'false')
  for (const u of atts) {
    try {
      const h = await fetchWithRetry(u, { method:'HEAD' }, { timeoutMs: 8000 })
      if (!h.ok) continue
      const size = Number(h.headers.get('content-length') || '0')
      if (size && size > max) {
        await cwPostJSON(url, { content:`Archivo grande, descargalo aquí: ${u}`, message_type:'outgoing', private:false })
        continue
      }
      const r = await fetchWithRetry(u, {}, { timeoutMs: 25000 })
      if (!r.ok) continue
      const buf = new Uint8Array(await r.arrayBuffer())
      const type = r.headers.get('content-type') || 'application/octet-stream'
      const blob = new Blob([buf], { type })
      form.append('attachments[]', blob, filenameFromUrl(u))
    } catch {}
  }
  const res = await fetchWithRetry(url, { method:'POST', headers: { 'api_access_token': CW_TOKEN }, body: form })
  const txt = await res.text()
  if (!res.ok) throw new Error(`Chatwoot ${res.status}: ${txt}`)
  return txt ? JSON.parse(txt) : {}
}
async function sendPrivate(convId, text) {
  const url = `${CW_BASE}/conversations/${convId}/messages`
  return cwPostJSON(url, { content: text, message_type:'outgoing', private:true, content_type:'text' })
}

const convLocks = new Map()
async function withConvLock(convId, fn) {
  const prev = convLocks.get(convId) || Promise.resolve()
  const next = prev.then(fn, fn)
  convLocks.set(convId, next.catch(() => {}))
  return next
}

/* ====== Baileys (Grupo) ====== */
let sock = null
let lastQR = { svg: null, png: null }

function isGroupJid(j){ return typeof j === 'string' && j.endsWith('@g.us') }

async function startSock () {
  const { state: auth, saveCreds } = await useMultiFileAuthState('./auth')
  const { version } = await fetchLatestBaileysVersion()
  sock = makeWASocket({
    version,
    auth,
    printQRInTerminal: false,
    browser: ['LunaBridge','Chrome','1.3'],
    markOnlineOnConnect: false,
    syncFullHistory: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) {
      lastQR.svg = await QRCode.toString(qr, { type: 'svg' })
      lastQR.png = await QRCode.toDataURL(qr, { margin: 1 })
    }
    if (connection === 'open') {
      try {
        if (!isGroupJid(SUPERVISOR_GROUP) && SUPERVISOR_GROUP_LINK) {
          const code = (SUPERVISOR_GROUP_LINK.split('/').pop() || '').trim()
          if (code) {
            const gid = await sock.groupAcceptInvite(code)
            SUPERVISOR_GROUP = gid + '@g.us'
            console.log('[GROUP] Joined via invite. JID:', SUPERVISOR_GROUP)
          }
        }
      } catch (e) { console.warn('[GROUP] Invite join error:', e?.message || e) }
    }
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) setTimeout(startSock, 3000)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      try {
        const from = m.key?.remoteJid || ''
        if (from !== SUPERVISOR_GROUP) continue

        const txt = (
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          m.message?.videoMessage?.caption ||
          ''
        ).trim()

        let convId = null
        const tokenMatch = txt.match(/\[#CW(\d+)\]/)
        if (tokenMatch) convId = tokenMatch[1]
        if (!convId) convId = state.__lastForwardConv || null
        if (!convId) continue

        if (txt.startsWith('+')) {
          const ok = await handleSupervisorCommand({ txt, convId })
          if (ok) continue
        }

        const clean = txt.replace(/\s*\[#CW\d+\]\s*/,'').trim()
        const c = touch(convId)
        const now = Date.now()
        const ANSWER_WINDOW = 60 * 1000
        const already = c.answeredAt && (now - c.answeredAt) < ANSWER_WINDOW

        if (clean) {
          if (!already) {
            const ttlDays = autoTtlDays(c.pendingQ?.text || clean, clean)
            const expiresAt = Date.now() + ttlDays * DAY
            LEARNED.push({ q: c.pendingQ?.text || clean, a: clean, at: Date.now(), source: 'supervisor', convId, group: SUPERVISOR_GROUP, expiresAt })
            saveLearned()
            await sendPrivate(convId, `📚 ${LUNA_NAME} aprendió: "${c.pendingQ?.text || '(n/a)'}" → "${clean}" (grupo)`)
            await sendOutgoing(convId, `_${LUNA_NAME}: ${clean}_`)
            c.pendingQ = null
            c.answeredAt = now
            saveState()
          } else {
            await sendPrivate(convId, `ℹ️ Otro supervisor agregó: "${clean}" (ignorado para evitar doble respuesta).`)
          }
        }

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
          const filename = mm[t]?.fileName || `wa_${Date.now()}.${mime.extension(mimetype) || 'bin'}`

          const url = `${CW_BASE}/conversations/${convId}/messages`
          const form = new FormData()
          form.append('content', caption ? `_${LUNA_NAME}: ${caption}_` : `_${LUNA_NAME} envió un archivo_`)
          form.append('message_type', 'outgoing')
          form.append('private', 'false')
          const blob = new Blob([buf], { type: mimetype })
          form.append('attachments[]', blob, filename)
          const res = await fetch(url, { method:'POST', headers: { 'api_access_token': CW_TOKEN }, body: form })
          if (!res.ok) console.warn('Attach CW error:', await res.text())
        }

      } catch (e) {
        console.error('Group upsert error:', e.message)
      }
    }
  })
}
startSock().catch(e => console.error('Baileys init error:', e))

async function forwardToGroup(convId, questionText, attachments=[]) {
  if (!SUPERVISOR_GROUP) throw new Error('SUPERVISOR_GROUP no configurado')
  const token = `[#CW${convId}]`
  const header = `Consulta de ${BRAND_NAME} ${token}\nPregunta: ${questionText?.trim() || '(sin texto)'}`
  await sock.sendMessage(SUPERVISOR_GROUP, { text: header })
  for (const u of attachments) {
    try {
      const r = await fetchWithRetry(u, {}, { timeoutMs: 25000 })
      if (!r.ok) continue
      const buf = Buffer.from(await r.arrayBuffer())
      const ct = r.headers.get('content-type') || 'application/octet-stream'
      if (ct.startsWith('image/')) await sock.sendMessage(SUPERVISOR_GROUP, { image: buf, caption: filenameFromUrl(u) })
      else if (ct.startsWith('video/')) await sock.sendMessage(SUPERVISOR_GROUP, { video: buf, caption: filenameFromUrl(u) })
      else if (ct.startsWith('audio/')) await sock.sendMessage(SUPERVISOR_GROUP, { audio: buf, mimetype: ct, ptt: false })
      else await sock.sendMessage(SUPERVISOR_GROUP, { document: buf, fileName: filenameFromUrl(u), mimetype: ct, caption: filenameFromUrl(u) })
    } catch (e) { console.warn('Forward attach error:', e?.message || e) }
  }
  state.__lastForwardConv = String(convId)
  saveState()
}

function verifySignature(req, _res, next){
  if (!WEBHOOK_SECRET) return next()
  try {
    const sig = req.headers['x-chatwoot-signature'] || ''
    const body = JSON.stringify(req.body || {})
    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')
    if (sig !== hmac) { console.warn('[WARN] Firma inválida'); return next('route') }
  } catch {}
  next()
}

function getMsgKey(ev, type){
  const id = ev?.message?.id ?? ev?.id ?? ev?.message?.message_id ?? ev?.created_at ?? ''
  const raw = (ev?.content || ev?.message?.content || '') + '|' + String(id) + '|' + type
  return crypto.createHash('sha1').update(raw).digest('hex')
}
const ATAJO_COOLDOWN_MS = 8000
function shouldFireAtajo(convState, type, key){
  const last = convState.lastAtajo
  const now = Date.now()
  if (last && (last.key === key)) return false
  if (last && last.type === type && (now - last.ts) < ATAJO_COOLDOWN_MS) return false
  convState.lastAtajo = { type, ts: now, key }
  return true
}

async function tryAtajoMinimal(ev, convId, c, cmd){
  if (cmd.includes('contactar asesor') || cmd.includes('continuar asesor')) {
    const key = getMsgKey(ev, 'ASESOR')
    if (!shouldFireAtajo(c, 'ASESOR', key)) return true
    await sendOutgoing(convId, 'Perfecto, te atiende el asesor.')
    await sendPrivate(convId, 'Asesor solicitado → activando puente Luna (grupo).')
    c.supActive = true
    saveState()
    const raw = ev?.content || ev?.message?.content || ''
    const attachments = (ev?.attachments || ev?.message?.attachments || []).map(a => a?.data_url || a?.file_url || a?.thumb_url).filter(Boolean)
    await lunaAnswerOrAsk(convId, raw, attachments)
    return true
  }
  return false
}

async function handleSupervisorCommand({ txt, convId }){
  const cmd = txt.trim()
  if (/^\+expiro\b/i.test(cmd)) {
    let arg = cmd.replace(/^\+expiro\b/i,'').replace(/\[#CW\d+\]/,'').trim()
    let count = 0
    for (const e of LEARNED) {
      const matchConv = String(e.convId || '') === String(convId)
      const matchArg  = !arg || norm(e.q).includes(norm(arg))
      if (matchConv && matchArg && !isExpired(e)) {
        e.expired = true
        e.expiresAt = Date.now() - 1
        count++
      }
    }
    saveLearned()
    await sendPrivate(convId, `🗑️ Expirado(s) ${count} registro(s) por +expiro${arg?` ("${arg}")`:''}.`)
    return true
  }
  return false
}

function findLearnedExact(text){
  const n = norm(text || '')
  return LEARNED.find(e => norm(e.q) === n && !isExpired(e))
}
async function lunaAnswerOrAsk(convId, rawText, attachments) {
  const c = touch(convId)
  c.supActive = true
  saveState()

  const exact = findLearnedExact(rawText || '')
  if (exact && exact.a) {
    await sendOutgoing(convId, `_${LUNA_NAME}: ${exact.a}_`)
    await sendPrivate(convId, `✅ Respuesta aprendida usada (grupo)`)
    return
  }

  const { score, answer, source } = findBestAnswer(rawText)
  if (answer && (score >= 0.58 || (source !== 'learned' && score >= 0.35))) {
    await sendOutgoing(convId, `_${LUNA_NAME}: ${answer}_`)
    await sendPrivate(convId, `Luna respondió (${source}) con score=${score.toFixed(2)}.`)
    return
  }

  await sendOutgoing(convId, `_${LUNA_NAME}: Estoy consultando con el equipo y te respondo al toque._`)
  c.pendingQ = { text: rawText, ts: Date.now() }
  c.answeredAt = 0
  saveState()
  await forwardToGroup(convId, rawText, attachments || [])
  await sendPrivate(convId, `Consulta enviada al grupo de supervisores. Pregunta: "${rawText}"`)
}

app.post('/chatwoot/bot', verifySignature, async (req, res) => {
  try {
    const ev     = req.body
    const convId = ev?.conversation?.id || ev?.id || ev?.message?.conversation_id
    const tipo   = ev?.message_type || ev?.message?.message_type || 'incoming'
    if (!convId || !tipo) return res.status(200).send('ok')

    await withConvLock(String(convId), async () => {
      const c   = touch(convId)
      const raw = ev?.content || ev?.message?.content || ''
      const cmd = norm(raw)

      const fired = await tryAtajoMinimal(ev, convId, c, cmd)
      if (fired) return

      if (tipo === 'incoming' && c.supActive) {
        const attachments = (ev?.attachments || ev?.message?.attachments || []).map(a => a?.data_url || a?.file_url || a?.thumb_url).filter(Boolean)
        await lunaAnswerOrAsk(convId, raw, attachments)
        return
      }

      await cwPostJSON(`${CW_BASE}/conversations/${convId}/messages`, {
        content: `Hola, soy ${LUNA_NAME}. ¿Querés hablar con un asesor?`,
        message_type: 'outgoing', private: false, content_type: 'text'
      })
    })

    return res.status(200).send('ok')
  } catch (e) {
    console.error('[BOT] Error:', e)
    return res.status(200).send('ok')
  }
})

app.post('/chatwoot/webhook', verifySignature, async (req, res) => {
  try {
    const ev     = req.body
    const convId = ev?.conversation?.id || ev?.id || ev?.conversation_id || ev?.message?.conversation_id
    if (!convId) return res.status(200).send('ok')

    await withConvLock(String(convId), async () => {
      const c   = touch(convId)
      const raw = ev?.content || ev?.message?.content || ''
      const cmd = norm(raw)

      const fired = await tryAtajoMinimal(ev, convId, c, cmd)
      if (fired) return

      const tipo = ev?.message_type || ev?.message?.message_type || 'incoming'
      const attachments = (ev?.attachments || ev?.message?.attachments || []).map(a => a?.data_url || a?.file_url || a?.thumb_url).filter(Boolean)

      if (tipo === 'incoming' && c.supActive) {
        await lunaAnswerOrAsk(convId, raw, attachments)
      }
    })

    return res.status(200).send('ok')
  } catch (e) {
    console.error('[WEBHOOK] Error:', e)
    return res.status(200).send('ok')
  }
})

app.get('/qr.svg', (_req, res) => {
  if (!lastQR.svg) return res.status(404).send('QR no disponible (esperá conexión)…')
  res.setHeader('Content-Type', 'image/svg+xml')
  res.send(lastQR.svg)
})
app.get('/qr.png', (_req, res) => {
  if (!lastQR.png) return res.status(404).send('QR no disponible (esperá conexión)…')
  const b64 = lastQR.png.split(',')[1]
  res.setHeader('Content-Type', 'image/png')
  res.send(Buffer.from(b64, 'base64'))
})

app.get('/healthz', (_req, res) => res.json({
  ok:true, ts:Date.now(),
  convs:Object.keys(state).length,
  group: SUPERVISOR_GROUP || null
}))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`BOT ${LUNA_NAME} listo :${PORT}, grupo=${SUPERVISOR_GROUP || 'unset'}`))
