import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  verify,
  type JsonWebKey,
} from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeviceClient, type Journal } from './device-client.js';
import { proofText } from './device-proof.js';
import type { InstallEnvelope } from './install-envelope.js';
import { SetupClient } from './setup-client.js';

/**
 * A stand-in portal: verifies every device proof the way the service does and
 * serves scripted responses. Nothing here talks to the real portal.
 */
type Handler = (request: { method: string; route: string; body: unknown; authorization?: string }) => {
  status?: number;
  body: unknown;
};
let server: Server;
let origin: string;
let root: string;
let journalFile: string;
let handler: Handler;
const seen: { method: string; route: string; body: unknown; proofValid: boolean; authorization?: string }[] = [];

function publicKeyOf(journal: Journal): JsonWebKey {
  if (!journal.publicKey) throw new Error('journal has no public key');
  return journal.publicKey;
}
async function journal(): Promise<Journal> {
  return JSON.parse(await readFile(journalFile, 'utf8')) as Journal;
}
async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  const route = new URL(req.url ?? '/', origin).pathname;
  const text = proofText(
    req.method ?? '',
    route,
    raw,
    String(req.headers['x-device-time']),
    String(req.headers['x-device-nonce']),
  );
  let proofValid = false;
  try {
    proofValid = verify(
      'sha256',
      Buffer.from(text),
      { key: createPublicKey({ key: publicKeyOf(await journal()), format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(String(req.headers['x-device-proof']), 'base64url'),
    );
  } catch (_error) {
    proofValid = false;
  }
  const request = {
    method: req.method ?? '',
    route,
    body: raw ? JSON.parse(raw) : undefined,
    authorization: req.headers.authorization,
  };
  seen.push({ ...request, proofValid });
  const reply = proofValid ? handler(request) : { status: 401, body: { error: 'invalid_proof' } };
  res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(reply.body));
}
function seal(publicJwk: JsonWebKey, context: string, credential: unknown): InstallEnvelope {
  const pair = generateKeyPairSync('x25519');
  const iv = randomBytes(12);
  const aad = Buffer.from(JSON.stringify(['nanoclaw-install-v1', context]));
  const secret = diffieHellman({
    privateKey: pair.privateKey,
    publicKey: createPublicKey({ key: publicJwk, format: 'jwk' }),
  });
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), aad, 32)), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credential)), cipher.final()]);
  return {
    version: 1,
    context,
    publicKey: pair.publicKey.export({ format: 'jwk' }),
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nc-portal-client-'));
  journalFile = path.join(root, 'data/community-portal.json');
  seen.length = 0;
  handler = () => ({ status: 404, body: { error: 'not_found' } });
  server = createServer((req, res) => void serve(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

describe('DeviceClient', () => {
  it('creates a private journal with fresh keys and signs every request with the device key', async () => {
    const client = await new DeviceClient({ origin, file: journalFile }).initialize();
    expect((await stat(journalFile)).mode & 0o777).toBe(0o600);
    const saved = await journal();
    expect(saved).toMatchObject({
      origin,
      installId: expect.any(String),
      privateKey: { kty: 'EC', crv: 'P-256', d: expect.any(String) },
      publicKey: { kty: 'EC', crv: 'P-256' },
      wrappingPrivateKey: { kty: 'OKP', crv: 'X25519', d: expect.any(String) },
      wrappingPublicKey: { kty: 'OKP', crv: 'X25519' },
      credentials: {},
      operations: {},
    });
    expect(saved.publicKey).not.toHaveProperty('d');
    handler = () => ({ body: { grants: [] } });
    await client.request('GET', '/api/v1/device/state');
    expect(seen).toEqual([
      { method: 'GET', route: '/api/v1/device/state', body: undefined, proofValid: true, authorization: undefined },
    ]);
    await client.stop();
    const again = await new DeviceClient({ origin, file: journalFile, token: 'tok' }).initialize();
    expect(again.local.installId).toBe(saved.installId);
    expect(again.local.privateKey).toEqual(saved.privateKey);
    await again.request('POST', '/api/v1/cell-ticket', {});
    expect(seen.at(-1)).toMatchObject({ method: 'POST', body: {}, proofValid: true, authorization: 'Bearer tok' });
    await again.stop();
  });

  it('refuses a plaintext origin off loopback, and a journal from another portal', async () => {
    expect(() => new DeviceClient({ origin: 'http://portal.example.test', file: journalFile })).toThrow('HTTPS');
    expect(() => new DeviceClient({ origin: 'https://portal.example.test/path', file: journalFile })).toThrow('HTTPS');
    const client = await new DeviceClient({ origin, file: journalFile }).initialize();
    await client.stop();
    await expect(
      new DeviceClient({ origin: 'https://portal.example.test', file: journalFile }).initialize(),
    ).rejects.toThrow('different portal');
  });

  it('surfaces the portal error code and status, and does not sign in when the journal is missing', async () => {
    const client = await new DeviceClient({ origin, file: journalFile }).initialize();
    handler = () => ({ status: 401, body: { error: 'invalid_token', message: 'Sign in again.' } });
    await expect(client.request('GET', '/api/v1/device/state')).rejects.toMatchObject({
      message: 'Sign in again.',
      code: 'invalid_token',
      status: 401,
    });
    await client.stop();
    await expect(
      new DeviceClient({ origin, file: path.join(root, 'data/none.json'), existingOnly: true }).initialize(),
    ).rejects.toMatchObject({ code: 'installation_required' });
  });

  it('exclusive clients wait for the journal lock and give up with journal_busy at the deadline', async () => {
    const first = await new DeviceClient({ origin, file: journalFile, exclusive: true }).initialize();
    const started = Date.now();
    await expect(
      new DeviceClient({ origin, file: journalFile, exclusive: true, waitForLockMs: 250 }).initialize(),
    ).rejects.toMatchObject({ code: 'journal_busy' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    const waiting = new DeviceClient({ origin, file: journalFile, exclusive: true, waitForLockMs: 5_000 }).initialize();
    setTimeout(() => void first.stop(), 100);
    const second = await waiting;
    expect(second.local.installId).toBe(first.local.installId);
    await second.stop();
  });

  it('redeems an active grant once, acknowledges it, and forgets credentials for grants that end', async () => {
    const client = await new DeviceClient({ origin, file: journalFile, token: 'tok' }).initialize();
    client.local.deviceId = 'dev-1';
    let redemptions = 0;
    const grant = {
      id: 'g1',
      perk: 'echo',
      desired: 'active',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      redemptions: [] as { deviceId: string; state: string; keyId: string; operationId: string }[],
    };
    handler = ({ method, route, body }) => {
      if (route === '/api/v1/device/state') return { body: { grants: [grant] } };
      if (route === '/api/v1/grants/echo/redeem') {
        redemptions++;
        expect(body).toEqual({ idempotencyKey: expect.any(String) });
        return { body: { keyId: 'k1', operationId: 'op1', secret: 'shh', resource: { label: 'Echo image' } } };
      }
      if (method === 'POST' && route === '/api/v1/grants/echo/ack') return { body: { ok: true } };
      return { status: 404, body: { error: 'not_found' } };
    };
    await client.reconcile();
    expect(redemptions).toBe(1);
    expect(seen.map((r) => r.route)).toEqual([
      '/api/v1/device/state',
      '/api/v1/grants/echo/redeem',
      '/api/v1/grants/echo/ack',
    ]);
    expect(seen.at(-1)?.body).toEqual({ operationId: 'op1', keyId: 'k1' });
    expect((await journal()).credentials.echo).toMatchObject({ keyId: 'k1', secret: 'shh' });
    // Delivered: nothing more to do. Same idempotency key would be reused otherwise.
    grant.redemptions = [{ deviceId: 'dev-1', state: 'DELIVERED', keyId: 'k1', operationId: 'op1' }];
    seen.length = 0;
    await client.reconcile();
    expect(seen.map((r) => r.route)).toEqual(['/api/v1/device/state']);
    grant.desired = 'revoked';
    await client.reconcile();
    expect((await journal()).credentials).toEqual({});
    expect(redemptions).toBe(1);
    await client.stop();
  });
});

describe('SetupClient', () => {
  it('runs a browser handoff: start, wait for approval, unseal the installation credential, complete', async () => {
    const client = await new SetupClient({ origin, file: journalFile, autoContinue: true, label: 'lab' }).initialize();
    let polls = 0;
    handler = ({ method, route, body }) => {
      if (route === '/api/v1/catalog')
        return {
          body: {
            items: [
              { id: 'echo', kind: 'account' },
              { id: 'tavily', kind: 'partner', enabled: false },
            ],
          },
        };
      if (route === '/api/v1/setup/start') {
        expect(body).toMatchObject({
          stage: 'echo',
          name: 'Nano',
          autoContinue: true,
          label: 'lab',
          installId: client.local.installId,
          publicKey: client.local.publicKey,
          wrappingKey: client.local.wrappingPublicKey,
        });
        return {
          body: {
            id: 'flow-1',
            code: 'code-1',
            url: `${origin}/setup/code-1`,
            installId: client.local.installId,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        };
      }
      if (route === '/api/v1/setup/code-1' && method === 'GET') {
        polls++;
        if (polls === 1) return { body: { id: 'flow-1', status: 'browsing' } };
        const credential = { token: 'install-token', account_id: 'acct-1', install_id: client.local.installId };
        return {
          body: {
            id: 'flow-1',
            status: 'approved',
            deviceId: 'dev-9',
            choice: { imageSource: 'hardened', workspaceId: 'T1', name: 'Nano' },
            envelope: seal(client.local.wrappingPublicKey!, `flow-1:${client.local.installId}`, credential),
          },
        };
      }
      if (route === '/api/v1/setup/code-1/complete') return { body: { ok: true } };
      return { status: 404, body: { error: 'not_found' } };
    };
    expect(await client.available('echo')).toBe(true);
    expect(await client.available('tavily')).toBe(false);
    expect(await client.available('perks')).toBe(false);
    const flow = await client.start('echo');
    expect(flow.url).toBe(`${origin}/setup/code-1`);
    expect((await journal()).setupFlow).toMatchObject({ code: 'code-1', stage: 'echo' });
    const states: string[] = [];
    const result = await client.wait({ pollMs: 5, onState: (state) => void states.push(state.status) });
    expect(states).toEqual(['browsing', 'approved']);
    expect(result).toMatchObject({ status: 'approved', choice: { imageSource: 'hardened' } });
    expect(result).not.toHaveProperty('envelope');
    expect(client.token).toBe('install-token');
    expect((await journal()).registryAccount).toEqual({
      token: 'install-token',
      account_id: 'acct-1',
      install_id: client.local.installId,
    });
    expect((await journal()).deviceId).toBe('dev-9');
    await client.complete('complete', { appId: 'A1' });
    expect(seen.at(-1)).toMatchObject({
      route: '/api/v1/setup/code-1/complete',
      body: { status: 'complete', appId: 'A1' },
      authorization: 'Bearer install-token',
    });
    await client.stop();
  });

  it('rejects a credential sealed for another installation and reports failed flows', async () => {
    const client = await new SetupClient({ origin, file: journalFile }).initialize();
    let status = 'failed';
    handler = ({ route }) => {
      if (route === '/api/v1/setup/start')
        return {
          body: {
            id: 'flow-2',
            code: 'code-2',
            url: `${origin}/setup/code-2`,
            installId: client.local.installId,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        };
      if (route === '/api/v1/setup/code-2')
        return {
          body: {
            id: 'flow-2',
            status,
            deviceId: 'dev-9',
            envelope: seal(client.local.wrappingPublicKey!, `flow-2:${client.local.installId}`, {
              token: 'install-token',
              account_id: 'acct-1',
              install_id: 'someone-else',
            }),
          },
        };
      return { status: 404, body: { error: 'not_found' } };
    };
    await client.start('slack');
    await expect(client.wait({ pollMs: 5 })).rejects.toThrow('cancelled or failed');
    status = 'approved';
    await expect(client.wait({ pollMs: 5 })).rejects.toThrow('Invalid installation credential');
    expect(client.token).toBeUndefined();
    expect((await journal()).registryAccount).toBeUndefined();
    await client.stop();
  });
});
