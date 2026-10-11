/* eslint-disable max-classes-per-file */

'use strict';

// Noise_NNpsk0_25519_ChaChaPoly_SHA256, the encryption of the ESPHome native API, built on
// node:crypto only. Initiator side (we are always the client).
// Spec: https://noiseprotocol.org/noise.html (sections 5 and 9).

const {
  createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync,
} = require('node:crypto');

const PROTOCOL_NAME = 'Noise_NNpsk0_25519_ChaChaPoly_SHA256';
const PROLOGUE = Buffer.from('NoiseAPIInit\x00\x00', 'binary');
const TAG_LEN = 16;
const EMPTY = Buffer.alloc(0);

const sha256 = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

/** Noise HKDF = RFC 5869 with the chaining key as salt and an empty info. */
function hkdf(ck, ikm, outputs) {
  const out = Buffer.from(hkdfSync('sha256', ikm, ck, EMPTY, 32 * outputs));
  const parts = [];
  for (let i = 0; i < outputs; i++) parts.push(out.subarray(i * 32, (i + 1) * 32));
  return parts;
}

/** 96-bit ChaCha20-Poly1305 nonce: 32 zero bits + 64-bit little-endian counter. */
function nonce(n) {
  const b = Buffer.alloc(12);
  b.writeUInt32LE(n >>> 0, 4);
  b.writeUInt32LE(Math.floor(n / 0x100000000), 8);
  return b;
}

function encrypt(key, n, ad, plaintext) {
  const c = createCipheriv('chacha20-poly1305', key, nonce(n), { authTagLength: TAG_LEN });
  c.setAAD(ad, { plaintextLength: plaintext.length });
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}

function decrypt(key, n, ad, ciphertext) {
  if (ciphertext.length < TAG_LEN) throw new Error('Ciphertext too short');
  const d = createDecipheriv('chacha20-poly1305', key, nonce(n), { authTagLength: TAG_LEN });
  d.setAAD(ad, { plaintextLength: ciphertext.length - TAG_LEN });
  d.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_LEN));
  return Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - TAG_LEN)), d.final()]);
}

/** Transport cipher after the handshake: one key, an incrementing nonce, no associated data. */
class CipherState {

  constructor(key) {
    this.key = key;
    this.n = 0;
  }

  encrypt(plaintext) {
    return encrypt(this.key, this.n++, EMPTY, plaintext);
  }

  decrypt(ciphertext) {
    return decrypt(this.key, this.n++, EMPTY, ciphertext);
  }

}

/**
 * Client handshake. Usage:
 *   const hs = new NoiseHandshake(psk);       // psk: 32-byte Buffer (the base64 API key, decoded)
 *   const msg1 = hs.writeMessage();            // send to the device
 *   hs.readMessage(reply);                     // reply from the device
 *   const { send, receive } = hs.split();      // CipherStates for the session
 */
class NoiseHandshake {

  constructor(psk) {
    if (!Buffer.isBuffer(psk) || psk.length !== 32) throw new Error('The encryption key must be 32 bytes (base64)');
    this.psk = psk;
    // Protocol name is longer than 32 bytes, so h = SHA256(name).
    this.h = sha256(Buffer.from(PROTOCOL_NAME, 'ascii'));
    this.ck = this.h;
    this.k = null;
    this.n = 0;
    this.mixHash(PROLOGUE);
  }

  mixHash(data) {
    this.h = sha256(this.h, data);
  }

  mixKey(ikm) {
    [this.ck, this.k] = hkdf(this.ck, ikm, 2);
    this.n = 0;
  }

  mixKeyAndHash(ikm) {
    let tempH;
    [this.ck, tempH, this.k] = hkdf(this.ck, ikm, 3);
    this.mixHash(tempH);
    this.n = 0;
  }

  encryptAndHash(plaintext) {
    const ct = encrypt(this.k, this.n++, this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext) {
    const pt = decrypt(this.k, this.n++, this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  /** -> psk, e */
  writeMessage() {
    this.mixKeyAndHash(this.psk);
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    this.ePriv = privateKey;
    const ePub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
    this.mixHash(ePub);
    this.mixKey(ePub); // psk handshakes also mix e into the key
    return Buffer.concat([ePub, this.encryptAndHash(EMPTY)]);
  }

  /** <- e, ee */
  readMessage(message) {
    if (message.length < 32 + TAG_LEN) throw new Error('Handshake reply too short');
    const re = message.subarray(0, 32);
    this.mixHash(re);
    this.mixKey(re);
    const remote = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: re.toString('base64url') }, format: 'jwk' });
    this.mixKey(diffieHellman({ privateKey: this.ePriv, publicKey: remote }));
    this.decryptAndHash(message.subarray(32)); // throws when the key is wrong
  }

  split() {
    const [k1, k2] = hkdf(this.ck, EMPTY, 2);
    this.psk = null;
    this.ePriv = null;
    return { send: new CipherState(Buffer.from(k1)), receive: new CipherState(Buffer.from(k2)) };
  }

}

module.exports = { NoiseHandshake };
