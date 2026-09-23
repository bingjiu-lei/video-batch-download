// Pure-JS SM3 hash. The Douyin a_bogus algorithm needs SM3, which
// node:crypto / WebCrypto don't provide, so we implement it here.
// Validated against the official vector
//   sm3("abc") = 66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0
//
// Input: an array (or Uint8Array) of byte ints. Output: 64-char hex.

const IV = [
  0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
  0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e
]

const rotl = (x, n) => {
  n %= 32
  return (((x << n) | (x >>> (32 - n))) >>> 0)
}

const p0 = x => (x ^ rotl(x, 9) ^ rotl(x, 17)) >>> 0
const p1 = x => (x ^ rotl(x, 15) ^ rotl(x, 23)) >>> 0
const tj = j => (j < 16 ? 0x79cc4519 : 0x7a879d8a)

const ff = (j, x, y, z) =>
  (j < 16 ? (x ^ y ^ z) : ((x & y) | (x & z) | (y & z))) >>> 0
const gg = (j, x, y, z) =>
  (j < 16 ? (x ^ y ^ z) : ((x & y) | ((~x) & z))) >>> 0

function cf (v, b) {
  const w = new Array(68)
  for (let i = 0; i < 16; i++) {
    w[i] = ((b[4 * i] << 24) | (b[4 * i + 1] << 16) | (b[4 * i + 2] << 8) | b[4 * i + 3]) >>> 0
  }
  for (let j = 16; j < 68; j++) {
    w[j] = (p1((w[j - 16] ^ w[j - 9] ^ rotl(w[j - 3], 15)) >>> 0) ^ rotl(w[j - 13], 7) ^ w[j - 6]) >>> 0
  }
  const w1 = new Array(64)
  for (let j = 0; j < 64; j++) w1[j] = (w[j] ^ w[j + 4]) >>> 0

  let [a, bb, c, d, e, f, g, h] = v
  for (let j = 0; j < 64; j++) {
    const ss1 = rotl((((rotl(a, 12) + e) >>> 0) + rotl(tj(j), j)) >>> 0, 7)
    const ss2 = (ss1 ^ rotl(a, 12)) >>> 0
    const tt1 = (((ff(j, a, bb, c) + d) >>> 0) + ((ss2 + w1[j]) >>> 0)) >>> 0
    const tt2 = (((gg(j, e, f, g) + h) >>> 0) + ((ss1 + w[j]) >>> 0)) >>> 0
    d = c
    c = rotl(bb, 9)
    bb = a
    a = tt1 >>> 0
    h = g
    g = rotl(f, 19)
    f = e
    e = p0(tt2) >>> 0
  }
  const o = [a, bb, c, d, e, f, g, h]
  return o.map((x, i) => (x ^ v[i]) >>> 0)
}

const toHex32 = x => (x >>> 0).toString(16).padStart(8, '0')

export function sm3Hash (msg) {
  const length = msg.length * 8
  const m = Array.from(msg)
  m.push(0x80)
  while (m.length % 64 !== 56) m.push(0x00)
  // 64-bit big-endian length. JS bit-ops are 32-bit; the high word is
  // 0 for any realistic message size here, so build it via division.
  for (let i = 0; i < 8; i++) {
    const shift = 8 * (7 - i)
    m.push(Math.floor(length / Math.pow(2, shift)) & 0xFF)
  }

  let v = IV.slice()
  for (let i = 0; i < m.length; i += 64) {
    v = cf(v, m.slice(i, i + 64))
  }
  return v.map(toHex32).join('')
}
