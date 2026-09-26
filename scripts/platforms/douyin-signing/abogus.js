// a_bogus generator — port of crawlers/douyin/web/abogus.py
// (the current Douyin web signature, replaced X-Bogus 2024-06-12).
// SM3 (x2) + RC4 + a custom base64 over the "s4" alphabet.
//
// Only the get_value() code path is ported (the upstream file also
// carries an unused self.sum/compress SM3 implementation — get_value
// uses the gmssl sm3_to_array path, which is our src/lib/sm3.js).
//
// Verified byte-for-byte against the Python reference for fixed
// time/random — see test/parity.mjs.
import { sm3Hash } from './sm3.js'
import { rc4 } from './common.js'

// ua_code is hardcoded in the upstream file for the default Chrome UA
// (the same DEFAULT_USER_AGENT in config.js). It does not vary with
// the UA string in this port.
const UA_CODE = [
  76, 98, 15, 131, 97, 245, 224, 133, 122, 199, 241, 166, 79, 34, 90,
  191, 128, 126, 122, 98, 66, 11, 14, 40, 49, 110, 110, 173, 67, 96, 138, 252
]

const BROWSER = '1536|742|1536|864|0|0|0|0|1536|864|1536|864|1536|742|24|24|MacIntel'
const BROWSER_CODE = Array.from(BROWSER, c => c.charCodeAt(0))
const END_STRING = 'cus'

const S4 = 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe'

// SM3 of a utf-8 string (or byte array) -> 32-byte int array.
const sm3ToArrayFromStr = (str) => {
  const bytes = typeof str === 'string'
    ? Array.from(new TextEncoder().encode(str))
    : str
  const hex = sm3Hash(bytes)
  const out = new Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
// SM3(SM3(str + "cus")) -> 32 bytes
const doubleSm3 = (str) => sm3ToArrayFromStr(sm3ToArrayFromStr(str + END_STRING))

// random_list — `a` truthy uses it, else random()*10000. We always
// pass an explicit number so it's deterministic.
function randomList (a, b, c, d, e, f, g) {
  const r = a || (Math.random() * 10000)
  const ri = Math.trunc(r)
  const v0 = ri & 255
  const v1 = ri >> 8
  return [
    (v0 & b) | d,
    (v0 & c) | e,
    (v1 & b) | f,
    (v1 & c) | g
  ]
}

const list1 = (n) => randomList(n, 170, 85, 1, 2, 5, 45 & 170)
const list2 = (n) => randomList(n, 170, 85, 1, 0, 0, 0)
const list3 = (n) => randomList(n, 170, 85, 1, 0, 5, 0)

// 64-bit-safe byte extraction: floor(v / 2^sh) mod 256 (JS bit shifts
// are 32-bit; timestamps exceed that).
const b256 = (v, sh) => Math.floor(v / Math.pow(2, sh)) % 256

function list4 (a, b, c, d, e, f, g, h, i, j, k, m, n, o, p, q, r) {
  return [
    44, a, 0, 0, 0, 0, 24, b, n, 0, c, d, 0, 0, 0, 1, 0, 239, e, o, f, g,
    0, 0, 0, 0, h, 0, 0, 14, i, j, 0, k, m, 3, p, 1, q, 1, r, 0, 0, 0
  ]
}

const endCheckNum = (arr) => arr.reduce((acc, x) => acc ^ x, 0)

function generateString2Codes (urlParams, method, startTime, endTime) {
  const paramsArray = doubleSm3(urlParams)
  const methodArray = doubleSm3(method)
  const a = list4(
    b256(endTime, 24), paramsArray[21], UA_CODE[23], b256(endTime, 16),
    paramsArray[22], UA_CODE[24], b256(endTime, 8), b256(endTime, 0),
    b256(startTime, 24), b256(startTime, 16), b256(startTime, 8), b256(startTime, 0),
    methodArray[21], methodArray[22],
    Math.floor(endTime / 4294967296), Math.floor(startTime / 4294967296),
    BROWSER.length
  )
  const e = endCheckNum(a)
  const full = a.concat(BROWSER_CODE)
  full.push(e)
  // RC4 with key "y" ([121]); plaintext codes may exceed 255, output
  // is kept as raw code numbers (no 8-bit truncation).
  return rc4([121], full)
}

function generateResult (codes, table) {
  const r = []
  const js = [18, 12, 6, 0]
  const ks = [0xFC0000, 0x03F000, 0x0FC0, 0x3F]
  for (let i = 0; i < codes.length; i += 3) {
    let n
    if (i + 2 < codes.length) n = (codes[i] << 16) | (codes[i + 1] << 8) | codes[i + 2]
    else if (i + 1 < codes.length) n = (codes[i] << 16) | (codes[i + 1] << 8)
    else n = codes[i] << 16
    for (let t = 0; t < 4; t++) {
      const j = js[t]
      if (j === 6 && i + 1 >= codes.length) break
      if (j === 0 && i + 2 >= codes.length) break
      r.push(table[(n & ks[t]) >> j])
    }
  }
  r.push('='.repeat((4 - (r.length % 4)) % 4))
  return r.join('')
}

// Generate the a_bogus value. `urlParams` is the urlencoded query
// string (same bytes that go in the final URL). opts lets tests pin
// time/random; production leaves them undefined for live values.
export function getABogus (urlParams, method = 'GET', opts = {}) {
  // randomList expects an integer-like value. Passing Math.random() directly
  // truncates almost every production sample to zero and makes signatures far
  // more deterministic than the browser implementation.
  const random = typeof opts.random === "function" ? opts.random : Math.random
  const r1 = opts.random1 ?? random() * 10000
  const r2 = opts.random2 ?? random() * 10000
  const r3 = opts.random3 ?? random() * 10000
  const startTime = opts.startTime ?? Date.now()
  const endTime = opts.endTime ?? (startTime + Math.floor(Math.random() * 5) + 4)

  const string1 = list1(r1).concat(list2(r2)).concat(list3(r3))
  const string2 = generateString2Codes(urlParams, method, startTime, endTime)
  const codes = string1.concat(string2)
  return generateResult(codes, S4)
}
