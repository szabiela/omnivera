import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

/**
 * Generates a one-time encryption key and IV for AES-256-GCM.
 * The key stays in Node.js. The key bytes are sent into the browser
 * for page.evaluate to encrypt the value before returning it.
 */
export function createExtractionKey() {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  return {
    key,
    iv,
    // These are passed into page.evaluate as arguments
    keyBytes: Array.from(key),
    ivBytes: Array.from(iv),
  };
}

/**
 * Decrypt a value that was encrypted inside the browser.
 */
export function decryptExtractedValue(
  encryptedHex: string,
  authTagHex: string,
  key: Buffer,
  iv: Buffer
): string {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Inject into page.evaluate to encrypt a value inside the browser.
 * Returns { encrypted: hex, authTag: hex } or null.
 *
 * Usage in page.evaluate:
 *   const result = await page.evaluate(encryptInBrowser, keyBytes, ivBytes);
 */
export const BROWSER_ENCRYPT_FUNCTION = `
  async function encryptValue(value, keyBytes, ivBytes) {
    const key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(keyBytes),
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );
    const encoded = new TextEncoder().encode(value);
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: new Uint8Array(ivBytes) },
      key,
      encoded
    );
    const bytes = new Uint8Array(encrypted);
    // Last 16 bytes are the auth tag in WebCrypto AES-GCM
    const ciphertext = bytes.slice(0, bytes.length - 16);
    const authTag = bytes.slice(bytes.length - 16);
    return {
      encrypted: Array.from(ciphertext).map(b => b.toString(16).padStart(2, '0')).join(''),
      authTag: Array.from(authTag).map(b => b.toString(16).padStart(2, '0')).join(''),
    };
  }
`;
