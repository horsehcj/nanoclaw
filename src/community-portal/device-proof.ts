import { createHash, createPrivateKey, randomBytes, sign, type JsonWebKey } from 'node:crypto';

/**
 * Per-request device proof. The portal verifies these headers against the
 * installation's registered P-256 public key; the text and encoding below are
 * the wire contract and are pinned by wire-vectors.json.
 */
export const PROOF_VERSION = 'nanoclaw-perks-device-v1';

export const random = (bytes = 24): string => randomBytes(bytes).toString('base64url');
export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

export function proofText(method: string, route: string, body: string, timestamp: string, nonce: string): string {
  return [PROOF_VERSION, method, route, sha256Hex(body), timestamp, nonce].join('\n');
}

export interface ProofHeaders {
  'x-device-time': string;
  'x-device-nonce': string;
  'x-device-proof': string;
}

/** ES256 over the proof text, IEEE P1363 encoded, base64url. */
export function deviceProof(privateKey: JsonWebKey, method: string, route: string, body = ''): ProofHeaders {
  const timestamp = String(Date.now());
  const nonce = random(16);
  const signature = sign('sha256', Buffer.from(proofText(method, route, body, timestamp, nonce)), {
    key: createPrivateKey({ key: privateKey, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return { 'x-device-time': timestamp, 'x-device-nonce': nonce, 'x-device-proof': signature };
}
