// Browser side of Clawkie's end-to-end encryption (pure WebCrypto, also imported by test.js under Node).
// Wire format matches clawkie.js: "e1:" + base64url(iv[12] | tag[16] | ciphertext), AES-256-GCM.
const enc = new TextEncoder(), dec = new TextDecoder()
export const b64 = buf => {
  let s = ''
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
const aes = (key, use) => crypto.subtle.importKey('raw', unb64(key), 'AES-GCM', false, [use])
const sha = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? enc.encode(s) : s))

export async function seal(text, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aes(key, 'encrypt'), enc.encode(text)))
  const ct = out.subarray(0, -16), tag = out.subarray(-16)
  const buf = new Uint8Array(28 + ct.length)
  buf.set(iv); buf.set(tag, 12); buf.set(ct, 28)
  return 'e1:' + b64(buf)
}
export async function unseal(s, key) { // null if it wasn't sealed with this key
  try {
    if (!s?.startsWith('e1:')) return null
    const buf = unb64(s.slice(3))
    const body = new Uint8Array(buf.length - 12)
    body.set(buf.subarray(28)); body.set(buf.subarray(12, 28), buf.length - 28)
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, await aes(key, 'decrypt'), body))
  } catch { return null }
}

export const newKey = () => b64(crypto.getRandomValues(new Uint8Array(32)))
// Lets the server check every device shares one key without learning it
export const fingerprint = async key => [...await sha('clawkie-kfp:' + key)].map(b => b.toString(16).padStart(2, '0')).join('')

// Wrap the account key for a CLI's ephemeral ECDH P-256 key: "<our pub>.<sealed key>"
export async function wrapFor(devicePub, key) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const theirs = await crypto.subtle.importKey('raw', unb64(devicePub), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, pair.privateKey, 256)
  return b64(await crypto.subtle.exportKey('raw', pair.publicKey)) + '.' + await seal(key, b64(await sha(new Uint8Array(shared))))
}

// Messages are sealed envelopes {from, to, ts, text}; only trust one whose inner sender matches the relay's label
export async function openMsg(row, key) {
  try {
    const env = JSON.parse(await unseal(row.text, key))
    return env.from === row.from_name ? env.text : null
  } catch { return null }
}
export const sealMsg = (to, text, key) => seal(JSON.stringify({ from: 'web', to, ts: Date.now(), text }), key)
