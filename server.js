const { createServer } = require('http')
const next = require('next')
const { WebSocketServer } = require('ws')
const { randomUUID } = require('crypto')

const dev = process.argv.includes('--dev')
const port = Number(process.env.PORT || process.env.SERVER_PORT) || 3000
const app = next({ dev })

// STUN by default; set TURN_URL (comma-separated), TURN_USERNAME, TURN_CREDENTIAL to add a TURN server.
const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]
if (process.env.TURN_URL) {
  iceServers.push({
    urls: process.env.TURN_URL.split(','),
    username: process.env.TURN_USERNAME,
    credential: process.env.TURN_CREDENTIAL,
  })
}

const clients = new Map() // id -> ws
const slots = Array(12).fill(null) // index -> peer id

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg))
const broadcast = (msg, except) => clients.forEach((ws, id) => id !== except && send(ws, msg))
const freeSlot = (id) => slots.forEach((p, i) => p === id && (slots[i] = null))

app.prepare().then(() => {
  const handle = app.getRequestHandler()
  const server = createServer((req, res) => handle(req, res))
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  const nextUpgrade = app.getUpgradeHandler()

  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws))
    else nextUpgrade(req, socket, head)
  })

  wss.on('connection', (ws) => {
    const id = randomUUID()
    ws.alive = true
    ws.on('pong', () => (ws.alive = true))
    ws.on('error', () => ws.terminate())

    send(ws, { type: 'hello', id, peers: [...clients.keys()], slots, iceServers })
    clients.set(id, ws)
    broadcast({ type: 'peer-joined', id }, id)

    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (msg.type === 'claim') {
        if (!Number.isInteger(msg.slot) || slots[msg.slot] !== null || slots.includes(id)) {
          return send(ws, { type: 'claim-failed' })
        }
        slots[msg.slot] = id
        broadcast({ type: 'slots', slots })
      } else if (msg.type === 'leave') {
        freeSlot(id)
        broadcast({ type: 'slots', slots })
      } else if (msg.type === 'signal') {
        const target = clients.get(msg.to)
        if (target) send(target, { type: 'signal', from: id, data: msg.data })
      }
    })

    ws.on('close', () => {
      clients.delete(id)
      freeSlot(id)
      broadcast({ type: 'peer-left', id })
      broadcast({ type: 'slots', slots })
    })
  })

  // Drop connections that vanished without closing (network loss), so their slot frees up.
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.alive) return ws.terminate()
      ws.alive = false
      ws.ping()
    })
  }, 30000)

  server.listen(port, '0.0.0.0', () => console.log(`> listening on :${port}`))
})
