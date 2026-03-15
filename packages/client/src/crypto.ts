/**
 * @omnivera/client — Crypto Module
 *
 * Handles client-side RSA-OAEP encryption of credentials using the Web Crypto API.
 * The public key is received from the ephemeral Browserbase container.
 * The host application's backend never has the corresponding private key.
 */

/**
 * Import an RSA-OAEP public key from the JWK format provided by the agent container.
 */
export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    {
      name: 'RSA-OAEP',
      hash: 'SHA-256',
    },
    false, // not extractable
    ['encrypt']
  );
}

/**
 * Encrypt credentials with the container's public key.
 * Returns a base64-encoded encrypted blob that only the container can decrypt.
 */
export async function encryptCredentials(
  publicKey: CryptoKey,
  credentials: Record<string, string>
): Promise<string> {
  const plaintext = new TextEncoder().encode(JSON.stringify(credentials));

  const encrypted = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    publicKey,
    plaintext
  );

  return arrayBufferToBase64(encrypted);
}

/**
 * Encrypt a 2FA code with the same session public key.
 */
export async function encrypt2FACode(
  publicKey: CryptoKey,
  code: string
): Promise<string> {
  const plaintext = new TextEncoder().encode(JSON.stringify({ tfa_code: code }));

  const encrypted = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    publicKey,
    plaintext
  );

  return arrayBufferToBase64(encrypted);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
