/**
 * Takes the other voices and the backing out of one voice's rehearsal file.
 *
 * Sing It's voice files are mixes of the same recordings (the backing and every voice, with
 * the file's own voice louder), so the parts of a file that are not its own voice can be
 * matched by a weighted sum of the other files of the song (the other voices and ALLA). The
 * weights are found where the voice rests: there the file holds nothing of its own, so the sum
 * that matches it best is the part to take away everywhere.
 *
 * If the files do not line up like that (the match removes less than half the sound where the
 * voice rests), the file is returned unchanged.
 */
export function isolateVoice(target: Float32Array, others: Float32Array[], sung: [number, number][], rate: number): Float32Array {
  const k = others.length
  if (!k) return target
  const n = Math.min(target.length, ...others.map((o) => o.length))
  const rest = new Uint8Array(n).fill(1)
  for (const [a, b] of sung) rest.fill(0, Math.max(0, Math.floor((a - 0.2) * rate)), Math.min(n, Math.ceil((b + 0.2) * rate)))
  // Least squares on every 4th sample is plenty and keeps it quick.
  const A = Array.from({ length: k }, () => new Float64Array(k))
  const y = new Float64Array(k)
  let before = 0
  let count = 0
  for (let i = 0; i < n; i += 4) {
    if (!rest[i]) continue
    const t = target[i]
    before += t * t
    count++
    for (let p = 0; p < k; p++) {
      const op = others[p][i]
      y[p] += op * t
      for (let q = p; q < k; q++) A[p][q] += op * others[q][i]
    }
  }
  if (count < rate / 4) return target // hardly any rests to learn from
  for (let p = 0; p < k; p++) for (let q = 0; q < p; q++) A[p][q] = A[q][p]
  const g = solve(A, y)
  if (!g) return target
  const out = new Float32Array(target.length)
  let after = 0
  for (let i = 0; i < target.length; i++) {
    let v = target[i]
    if (i < n) for (let p = 0; p < k; p++) v -= g[p] * others[p][i]
    out[i] = v
    if (i < n && i % 4 === 0 && rest[i]) after += v * v
  }
  return after < before / 2 ? out : target
}

/** Solves A x = y (small, symmetric) by Gaussian elimination with pivoting. */
function solve(A: Float64Array[], y: Float64Array): Float64Array | null {
  const k = y.length
  const M = A.map((r, i) => [...r, y[i]])
  for (let c = 0; c < k; c++) {
    let p = c
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (Math.abs(M[p][c]) < 1e-9) return null
    ;[M[c], M[p]] = [M[p], M[c]]
    for (let r = 0; r < k; r++) {
      if (r === c) continue
      const f = M[r][c] / M[c][c]
      for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j]
    }
  }
  return Float64Array.from({ length: k }, (_, i) => M[i][k] / M[i][i])
}
