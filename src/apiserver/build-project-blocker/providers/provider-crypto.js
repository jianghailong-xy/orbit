"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encryptSecret = encryptSecret;
exports.decryptSecret = decryptSecret;
const crypto_1 = require("crypto");
// A control-plane-configured provider's API key is stored AES-256-GCM encrypted at rest, so
// the raw key never sits in the DB in plaintext. The 32-byte key is derived from the
// PROVIDER_SECRET_KEY env secret (required to create/read a provider key); rotating that
// secret means re-entering each provider's key — acceptable for Phase 1.
function aesKey() {
    const secret = process.env.PROVIDER_SECRET_KEY;
    if (!secret) {
        throw new Error('PROVIDER_SECRET_KEY is required to store/read model-provider API keys');
    }
    return (0, crypto_1.createHash)('sha256').update(secret).digest();
}
/** AES-256-GCM encrypt a provider API key → "iv:tag:ct" (each base64). */
function encryptSecret(plaintext) {
    const iv = (0, crypto_1.randomBytes)(12);
    const cipher = (0, crypto_1.createCipheriv)('aes-256-gcm', aesKey(), iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, ct].map((b) => b.toString('base64')).join(':');
}
/** Reverse of {@link encryptSecret}. Throws on a tampered/mis-keyed ciphertext (GCM auth). */
function decryptSecret(stored) {
    const [ivB64, tagB64, ctB64] = stored.split(':');
    if (!ivB64 || !tagB64 || !ctB64)
        throw new Error('malformed encrypted secret');
    const decipher = (0, crypto_1.createDecipheriv)('aes-256-gcm', aesKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
        decipher.update(Buffer.from(ctB64, 'base64')),
        decipher.final(),
    ]).toString('utf8');
}
//# sourceMappingURL=provider-crypto.js.map