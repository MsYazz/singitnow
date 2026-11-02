import { fft } from './fft'

/**
 * Front end and read-out for the FCPE pitch model (torchfcpe, MIT): 128-band log-mel at 16 kHz,
 * 1024-point frames every 10 ms, the same as torchfcpe computes it before the network.
 */
export const PITCH_MELS = 128
export const PITCH_HOP = 160
export const PITCH_FPS = 100
const SR = 16000
const NFFT = 1024
const OUT = 360

// Slaney mel scale, as librosa's default.
const F_SP = 200 / 3
const MIN_LOG_HZ = 1000
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP
const LOGSTEP = Math.log(6.4) / 27
const hzToMel = (f: number) => (f >= MIN_LOG_HZ ? MIN_LOG_MEL + Math.log(f / MIN_LOG_HZ) / LOGSTEP : f / F_SP)
const melToHz = (m: number) => (m >= MIN_LOG_MEL ? MIN_LOG_HZ * Math.exp(LOGSTEP * (m - MIN_LOG_MEL)) : F_SP * m)

let setup: { win: Float32Array; banks: { start: number; w: Float32Array }[] } | null = null
function filters() {
  if (setup) return setup
  const win = new Float32Array(NFFT)
  for (let i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT)
  const bins = NFFT / 2 + 1
  const lo = hzToMel(0)
  const hi = hzToMel(SR / 2)
  const pts = Array.from({ length: PITCH_MELS + 2 }, (_, i) => melToHz(lo + ((hi - lo) * i) / (PITCH_MELS + 1)))
  const banks: { start: number; w: Float32Array }[] = []
  for (let m = 0; m < PITCH_MELS; m++) {
    const enorm = 2 / (pts[m + 2] - pts[m])
    const w: number[] = []
    let start = -1
    for (let k = 0; k < bins; k++) {
      const f = (k * SR) / NFFT
      const v = Math.max(0, Math.min((f - pts[m]) / (pts[m + 1] - pts[m]), (pts[m + 2] - f) / (pts[m + 2] - pts[m + 1])))
      if (v > 0) {
        if (start < 0) start = k
        w[k - start] = v * enorm
      }
    }
    banks.push({ start: Math.max(0, start), w: Float32Array.from(w, (x) => x ?? 0) })
  }
  setup = { win, banks }
  return setup
}

/** Log-mel spectrogram, [frames x 128] row-major, one frame per 10 ms (frame i at i × 10 ms). */
export function pitchMel(x: Float32Array): { frames: number; data: Float32Array } {
  const { win, banks } = filters()
  const padL = (NFFT - PITCH_HOP) >> 1
  const padR = (NFFT - PITCH_HOP + 1) >> 1
  const n = x.length
  // Reflect padding, as torch.nn.functional.pad(mode='reflect').
  const at = (i: number) => {
    if (n < 2) return 0
    let j = i - padL
    while (j < 0 || j >= n) j = j < 0 ? -j : 2 * (n - 1) - j
    return Math.max(-1, Math.min(1, x[j]))
  }
  const avail = Math.floor((n + padL + padR - NFFT) / PITCH_HOP) + 1
  const frames = Math.floor(n / PITCH_HOP) + 1
  const data = new Float32Array(frames * PITCH_MELS)
  const re = new Float32Array(NFFT)
  const im = new Float32Array(NFFT)
  const mag = new Float32Array(NFFT / 2 + 1)
  for (let t = 0; t < frames; t++) {
    const src = Math.min(t, Math.max(0, avail - 1)) // repeat the last frame, as torchfcpe does
    if (t === src || t === 0) {
      for (let i = 0; i < NFFT; i++) {
        re[i] = at(src * PITCH_HOP + i) * win[i]
        im[i] = 0
      }
      fft(re, im)
      for (let k = 0; k <= NFFT / 2; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k] + 1e-9)
    }
    for (let m = 0; m < PITCH_MELS; m++) {
      const { start, w } = banks[m]
      let s = 0
      for (let k = 0; k < w.length; k++) s += w[k] * mag[start + k]
      data[t * PITCH_MELS + m] = Math.log(Math.max(s, 1e-5))
    }
  }
  return { frames, data }
}

const centOf = (f: number) => 1200 * Math.log2(f / 10)
const C0 = centOf(32.7)
const C1 = centOf(1975.5)

/**
 * Pitch per frame from the model's output ([frames x 360]): a weighted mean of the 9 bins
 * around the strongest one. 0 where the model hears no clear pitch.
 */
export function readPitch(latent: Float32Array, frames: number, threshold = 0.006): { hz: Float32Array; conf: Float32Array } {
  const hz = new Float32Array(frames)
  const conf = new Float32Array(frames)
  for (let t = 0; t < frames; t++) {
    const row = t * OUT
    let best = 0
    for (let k = 1; k < OUT; k++) if (latent[row + k] > latent[row + best]) best = k
    const c = latent[row + best]
    conf[t] = c
    if (c <= threshold) continue
    let num = 0
    let den = 0
    for (let k = best - 4; k <= best + 4; k++) {
      const kk = Math.max(0, Math.min(OUT - 1, k))
      const y = latent[row + kk]
      num += (C0 + ((C1 - C0) * kk) / (OUT - 1)) * y
      den += y
    }
    hz[t] = 10 * Math.pow(2, num / den / 1200)
  }
  return { hz, conf }
}
