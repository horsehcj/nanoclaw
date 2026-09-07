import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

/**
 * The installation credential travels browser → portal → CLI sealed to the
 * installation's X25519 wrapping key, so only the originating checkout can
 * read it. Format: X25519 ECDH, HKDF-SHA256 keyed on the setup context,
 * AES-256-GCM with that context as associated data. Pinned by wire-vectors.json.
 */
export const ENVELOPE_VERSION = 'nanoclaw-install-v1';

export interface InstallEnvelope {
  version: 1;
  context: string;
  publicKey: JsonWebKey;
  iv: string;
  ciphertext: string;
  tag: string;
}

export function wrappingKey(jwk: JsonWebKey | undefined): JsonWebKey {
  if (jwk?.kty !== 'OKP' || jwk.crv !== 'X25519' || jwk.d || !/^[\w-]{43}$/.test(jwk.x || ''))
    throw new Error('Invalid installation wrapping key');
  const key: JsonWebKey = { kty: 'OKP', crv: 'X25519', x: jwk.x };
  createPublicKey({ key, format: 'jwk' });
  return key;
}

const aad = (context: string): Buffer => Buffer.from(JSON.stringify([ENVELOPE_VERSION, context]));

function derive(privateKey: KeyObject, publicKey: KeyObject, context: string): Buffer {
  const secret = diffieHellman({ privateKey, publicKey });
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), aad(context), 32));
}

export function openInstall<T = unknown>(
  privateJwk: JsonWebKey,
  expectedContext: string,
  envelope: InstallEnvelope | undefined,
): T {
  if (envelope?.version !== 1 || envelope.context !== expectedContext)
    throw new Error('Installation credential belongs to another setup');
  const key = derive(
    createPrivateKey({ key: privateJwk, format: 'jwk' }),
    createPublicKey({ key: wrappingKey(envelope.publicKey), format: 'jwk' }),
    expectedContext,
  );
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
  decipher.setAAD(aad(expectedContext));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  return JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString(),
  ) as T;
}
