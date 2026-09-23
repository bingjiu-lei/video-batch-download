// Shared byte primitives for the X-Bogus / a_bogus ports. All work on
// plain arrays of byte ints (0-255) to mirror the Python source's
// list-of-ints style and avoid Buffer/TypedArray edge cases.
//
// String -> byte array, latin1 (ISO-8859-1): one byte per char, char
// codes assumed <= 0xFF (true for UA / url / RC4 output).
export const strToBytes = (s) => {
  const out = new Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF
  return out
}

// Byte array -> latin1 string.
export const bytesToStr = (bytes) => {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0xFF)
  return s
}

// charCodeAt array (may include code points > 255, used by a_bogus for
// the s4 base64 step which reads char codes directly).
export const charCodes = (s) => {
  const out = new Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

// RC4. key and data are byte-int arrays; returns a byte-int array.
export function rc4 (key, data) {
  const s = new Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) % 256
    const t = s[i]; s[i] = s[j]; s[j] = t
  }
  const out = new Array(data.length)
  let a = 0; let b = 0
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) % 256
    b = (b + s[a]) % 256
    const t = s[a]; s[a] = s[b]; s[b] = t
    out[k] = data[k] ^ s[(s[a] + s[b]) % 256]
  }
  return out
}

// base64 (standard) of a byte-int array.
export const base64OfBytes = (bytes) => {
  // Build a binary string then btoa-equivalent via manual table to
  // avoid Buffer dependency assumptions in workerd.
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] & 0xFF)
  if (typeof btoa === 'function') return btoa(bin)
  // Fallback for environments without btoa.
  return globalThis.Buffer.from(bytes.map(b => b & 0xFF)).toString('base64')
}



