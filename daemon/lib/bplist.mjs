// Minimal binary property list reader (Apple's bplist00), enough for Notification Center records.
export function parseBplist(input) {
  const b = Buffer.from(input)
  if (b.toString('latin1', 0, 8) !== 'bplist00') throw Error('not a binary plist')
  const t = b.length - 32
  const offsetSize = b[t + 6]
  const refSize = b[t + 7]
  const count = Number(b.readBigUInt64BE(t + 8))
  const top = Number(b.readBigUInt64BE(t + 16))
  const tableAt = Number(b.readBigUInt64BE(t + 24))
  const uint = (at, size) => { let v = 0; for (let i = 0; i < size; i++) v = v * 256 + b[at + i]; return v }
  const offsets = Array.from({ length: count }, (_, i) => uint(tableAt + i * offsetSize, offsetSize))

  // A length marker of 0xF means the real length follows as an int object.
  const length = (at, low) => {
    if (low !== 0xf) return [low, at + 1]
    const size = 1 << (b[at + 1] & 0xf)
    return [uint(at + 2, size), at + 2 + size]
  }

  const read = (ref, depth = 0) => {
    if (depth > 64) throw Error('plist too deep')
    const at = offsets[ref]
    const marker = b[at]
    const high = marker >> 4
    const low = marker & 0xf
    switch (high) {
      case 0x0: return low === 0x8 ? false : low === 0x9 ? true : null
      case 0x1: return low === 3 ? Number(b.readBigInt64BE(at + 1)) : uint(at + 1, 1 << low)
      case 0x2: return low === 2 ? b.readFloatBE(at + 1) : b.readDoubleBE(at + 1)
      case 0x3: return new Date((b.readDoubleBE(at + 1) + 978_307_200) * 1000)
      case 0x4: { const [n, s] = length(at, low); return b.subarray(s, s + n) }
      case 0x5: { const [n, s] = length(at, low); return b.toString('latin1', s, s + n) }
      case 0x6: { const [n, s] = length(at, low); return Buffer.from(b.subarray(s, s + n * 2)).swap16().toString('utf16le') }
      case 0x8: return { uid: uint(at + 1, low + 1) }
      case 0xa: { const [n, s] = length(at, low); return Array.from({ length: n }, (_, i) => read(uint(s + i * refSize, refSize), depth + 1)) }
      case 0xd: {
        const [n, s] = length(at, low)
        const out = {}
        for (let i = 0; i < n; i++) out[read(uint(s + i * refSize, refSize), depth + 1)] = read(uint(s + (n + i) * refSize, refSize), depth + 1)
        return out
      }
      default: return null
    }
  }
  return read(top)
}
