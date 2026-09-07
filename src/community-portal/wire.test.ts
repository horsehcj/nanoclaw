import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deviceProof, proofText } from './device-proof.js';
import { openInstall, type InstallEnvelope } from './install-envelope.js';

/**
 * wire-vectors.json was produced by the hosted portal's own signer and the
 * registry's own envelope sealer. These tests pin the open-source client to
 * that contract without sharing code with the service.
 */
interface ProofCase {
  method: string;
  route: string;
  body: string;
  timestamp: string;
  nonce: string;
  proofText: string;
  signature: string;
}
interface Vectors {
  proof: { privateKey: JsonWebKey; publicKey: JsonWebKey; cases: ProofCase[] };
  envelope: {
    wrappingPrivateKey: JsonWebKey;
    wrappingPublicKey: JsonWebKey;
    context: string;
    credential: Record<string, string>;
    envelope: InstallEnvelope;
  };
}
const vectors = JSON.parse(readFileSync(new URL('./wire-vectors.json', import.meta.url), 'utf8')) as Vectors;
const publicKey = createPublicKey({ key: vectors.proof.publicKey, format: 'jwk' });
const verifies = (text: string, signature: string): boolean =>
  verify(
    'sha256',
    Buffer.from(text),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  );

describe('portal wire contract', () => {
  it('reproduces the portal signing text for each recorded request', () => {
    for (const c of vectors.proof.cases)
      expect(proofText(c.method, c.route, c.body, c.timestamp, c.nonce)).toBe(c.proofText);
  });

  it('accepts the portal-generated signatures under the recorded public key', () => {
    for (const c of vectors.proof.cases)
      expect(verifies(proofText(c.method, c.route, c.body, c.timestamp, c.nonce), c.signature)).toBe(true);
  });

  it('produces proofs in the form the portal verifier requires', () => {
    // Mirror of the portal's checks: 13-digit millisecond timestamp, 16–80
    // character nonce, ES256 (P1363) over the same text.
    const headers = deviceProof(vectors.proof.privateKey, 'POST', '/api/v1/cell-ticket', '{}');
    expect(headers['x-device-time']).toMatch(/^\d{13}$/);
    expect(Math.abs(Date.now() - Number(headers['x-device-time']))).toBeLessThan(5_000);
    expect(headers['x-device-nonce']).toMatch(/^[\w-]{16,80}$/);
    const text = proofText('POST', '/api/v1/cell-ticket', '{}', headers['x-device-time'], headers['x-device-nonce']);
    expect(verifies(text, headers['x-device-proof'])).toBe(true);
    const otherBody = proofText(
      'POST',
      '/api/v1/cell-ticket',
      '{ }',
      headers['x-device-time'],
      headers['x-device-nonce'],
    );
    expect(verifies(otherBody, headers['x-device-proof'])).toBe(false);
  });

  it('opens an installation envelope sealed by the registry', () => {
    const { wrappingPrivateKey, context, envelope, credential } = vectors.envelope;
    expect(openInstall(wrappingPrivateKey, context, envelope)).toEqual(credential);
  });

  it('rejects an envelope for another setup or with a tampered tag', () => {
    const { wrappingPrivateKey, context, envelope } = vectors.envelope;
    expect(() => openInstall(wrappingPrivateKey, 'other-flow:other-install', envelope)).toThrow('another setup');
    const flipped = envelope.tag.endsWith('A') ? `${envelope.tag.slice(0, -1)}B` : `${envelope.tag.slice(0, -1)}A`;
    expect(() => openInstall(wrappingPrivateKey, context, { ...envelope, tag: flipped })).toThrow();
    expect(() => openInstall(wrappingPrivateKey, context, { ...envelope, publicKey: { kty: 'EC' } })).toThrow(
      'wrapping key',
    );
  });
});
