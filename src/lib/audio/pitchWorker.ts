/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm'
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import { PITCH_MELS, pitchMel, readPitch } from './pitch'

ort.env.wasm.wasmPaths = { wasm: wasmUrl }
ort.env.wasm.numThreads = 1

const CHUNK = 3000 // frames (30 s) per run, to keep memory low on small devices
const OVERLAP = 250

async function loadModel(url: string): Promise<ArrayBuffer> {
  const get = async () => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Kunde inte hämta tonhöjdsmodellen (${res.status})`)
    return res.arrayBuffer()
  }
  try {
    const cache = await caches.open('singitnow-models')
    const hit = await cache.match(url)
    if (hit) return hit.arrayBuffer()
    const buf = await get()
    await cache.put(url, new Response(buf.slice(0)))
    return buf
  } catch {
    return get()
  }
}

let session: Promise<ort.InferenceSession> | null = null

/** Pitch of one voice: Hz per 10 ms frame (0 where there is no clear pitch). */
self.onmessage = async (e: MessageEvent<{ modelUrl: string; pcm: Float32Array }>) => {
  try {
    session ??= loadModel(e.data.modelUrl).then((b) => ort.InferenceSession.create(b, { executionProviders: ['wasm'] }))
    const s = await session
    const mel = pitchMel(e.data.pcm)
    const hz = new Float32Array(mel.frames)
    for (let c = 0; c < mel.frames; c += CHUNK) {
      const a = Math.max(0, c - OVERLAP)
      const b = Math.min(mel.frames, c + CHUNK + OVERLAP)
      const x = mel.data.slice(a * PITCH_MELS, b * PITCH_MELS)
      const out = await s.run({ mel: new ort.Tensor('float32', x, [1, b - a, PITCH_MELS]) })
      const p = readPitch(out[s.outputNames[0]].data as Float32Array, b - a)
      hz.set(p.hz.subarray(c - a, Math.min(b, c + CHUNK) - a), c)
      self.postMessage({ progress: Math.min(1, (c + CHUNK) / mel.frames) })
    }
    self.postMessage({ hz }, [hz.buffer])
  } catch (err) {
    session = null
    self.postMessage({ error: err instanceof Error ? err.message : String(err) })
  }
}
