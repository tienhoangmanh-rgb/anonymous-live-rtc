'use client'

import { useEffect, useRef, useState } from 'react'

type Peer = { pc: RTCPeerConnection; polite: boolean; makingOffer: boolean; ignoreOffer: boolean }

function Video({ stream }: { stream?: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream ?? null
  }, [stream])
  return <video ref={ref} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
}

export default function Home() {
  const [myId, setMyId] = useState('')
  const [slots, setSlots] = useState<(string | null)[]>(Array(12).fill(null))
  const [streams, setStreams] = useState<Record<string, MediaStream>>({})
  const joinRef = useRef<(slot: number) => void>(() => {})

  useEffect(() => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    const peers = new Map<string, Peer>()
    let me = ''
    let iceServers: RTCIceServer[] = []
    let others: string[] = []
    let local: MediaStream | null = null

    const send = (msg: object) => ws.readyState === 1 && ws.send(JSON.stringify(msg))
    const setStream = (id: string, s?: MediaStream) =>
      setStreams((prev) => {
        const next = { ...prev }
        if (s) next[id] = s
        else delete next[id]
        return next
      })

    const addLocalTracks = (pc: RTCPeerConnection) => {
      if (local && pc.getSenders().every((s) => !s.track)) local.getTracks().forEach((t) => pc.addTrack(t, local!))
    }

    // Perfect negotiation: one RTCPeerConnection per remote peer, created on demand.
    const getPeer = (id: string) => {
      let p = peers.get(id)
      if (p) return p
      const pc = new RTCPeerConnection({ iceServers })
      const peer: Peer = { pc, polite: me < id, makingOffer: false, ignoreOffer: false }
      pc.onnegotiationneeded = async () => {
        try {
          peer.makingOffer = true
          await pc.setLocalDescription()
          send({ type: 'signal', to: id, data: { description: pc.localDescription } })
        } finally {
          peer.makingOffer = false
        }
      }
      pc.onicecandidate = ({ candidate }) => candidate && send({ type: 'signal', to: id, data: { candidate } })
      pc.ontrack = ({ streams: [s] }) => setStream(id, s)
      peers.set(id, peer)
      addLocalTracks(pc)
      return peer
    }

    const onSignal = async (from: string, { description, candidate }: any) => {
      const peer = getPeer(from)
      const { pc } = peer
      if (description) {
        const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable')
        peer.ignoreOffer = !peer.polite && collision
        if (peer.ignoreOffer) return
        await pc.setRemoteDescription(description)
        if (description.type === 'offer') {
          await pc.setLocalDescription()
          send({ type: 'signal', to: from, data: { description: pc.localDescription } })
        }
      } else if (candidate) {
        try {
          await pc.addIceCandidate(candidate)
        } catch (e) {
          if (!peer.ignoreOffer) throw e
        }
      }
    }

    const leave = () => {
      if (!local) return
      local.getTracks().forEach((t) => t.stop())
      local = null
      peers.forEach(({ pc }) => pc.getSenders().forEach((s) => s.track && pc.removeTrack(s)))
      setStream(me)
      send({ type: 'leave' })
    }

    joinRef.current = async (slot) => {
      if (local) return
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: 'browser' },
          audio: false,
          preferCurrentTab: false,
          selfBrowserSurface: 'exclude',
          monitorTypeSurfaces: 'exclude',
        } as DisplayMediaStreamOptions)
      } catch {
        return
      }
      const track = stream.getVideoTracks()[0]
      const surface = track.getSettings().displaySurface
      if (surface && surface !== 'browser') {
        stream.getTracks().forEach((t) => t.stop())
        alert('Vui lòng chọn 1 tab trình duyệt để chia sẻ.')
        return
      }
      local = stream
      track.onended = leave
      setStream(me, stream)
      send({ type: 'claim', slot })
      others.forEach((id) => addLocalTracks(getPeer(id).pc))
    }

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      switch (msg.type) {
        case 'hello':
          me = msg.id
          iceServers = msg.iceServers
          others = msg.peers
          setMyId(me)
          setSlots(msg.slots)
          break
        case 'slots':
          setSlots(msg.slots)
          break
        case 'claim-failed':
          leave()
          alert('Ô này đã có người, chọn ô khác.')
          break
        case 'peer-joined':
          others.push(msg.id)
          if (local) getPeer(msg.id)
          break
        case 'peer-left':
          others = others.filter((id) => id !== msg.id)
          peers.get(msg.id)?.pc.close()
          peers.delete(msg.id)
          setStream(msg.id)
          break
        case 'signal':
          onSignal(msg.from, msg.data).catch(console.error)
          break
      }
    }

    return () => {
      local?.getTracks().forEach((t) => t.stop())
      peers.forEach(({ pc }) => pc.close())
      ws.close()
    }
  }, [])

  const mine = slots.includes(myId)

  return (
    <main
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gridTemplateRows: 'repeat(3, 1fr)',
        gap: 2,
        height: '100vh',
      }}
    >
      {slots.map((owner, i) => (
        <div
          key={i}
          onClick={() => !owner && !mine && joinRef.current(i)}
          style={{
            background: '#111',
            display: 'grid',
            placeItems: 'center',
            overflow: 'hidden',
            cursor: !owner && !mine ? 'pointer' : 'default',
            outline: owner === myId ? '2px solid #0af' : undefined,
          }}
        >
          {owner ? (
            streams[owner] ? <Video stream={streams[owner]} /> : <span style={{ opacity: 0.5 }}>Đang kết nối…</span>
          ) : (
            <span style={{ opacity: 0.4 }}>{mine ? 'Trống' : '+ Bấm để join'}</span>
          )}
        </div>
      ))}
    </main>
  )
}
