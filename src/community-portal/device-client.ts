import { generateKeyPairSync, randomUUID, type JsonWebKey } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CellLog } from './cell-connection.js';
import { deviceProof, random } from './device-proof.js';
import { portalError } from './errors.js';
import { readJson, writePrivate } from './private-file.js';
import { processLock } from './process-lock.js';

/**
 * A checkout's identity at the community portal. Everything durable lives in
 * one private journal (`data/community-portal.json`): the P-256 device key that
 * signs every request, the X25519 wrapping key that receives the installation
 * credential, and the perk credentials the account has granted this device.
 */
export interface RegistryAccount {
  token: string;
  account_id: string;
  install_id: string;
  registry?: string;
  api?: string;
  [key: string]: unknown;
}

export interface Redemption {
  deviceId?: string;
  state?: string;
  keyId?: string;
  operationId?: string;
}

export interface Grant {
  id: string;
  perk: string;
  desired: string;
  expiresAt: string;
  redemptions: Redemption[];
}

export interface DeviceState {
  grants: Grant[];
  activations?: Record<string, { enabled?: boolean } | undefined>;
  [key: string]: unknown;
}

export interface Credential {
  keyId: string;
  operationId: string;
  secret?: string;
  resource: { label: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface SetupFlow {
  id: string;
  code: string;
  url: string;
  installId: string;
  expiresAt: string;
  stage?: string;
  [key: string]: unknown;
}

export interface SlackSetup {
  setupId: string;
  workspaceId: string;
  name: string;
  status: 'creating' | 'received' | 'complete';
  serviceBase?: string;
  app?: { appId: string; appToken: string; botToken?: string };
}

export interface Journal {
  origin?: string;
  installId?: string;
  deviceId?: string;
  privateKey: JsonWebKey;
  publicKey?: JsonWebKey;
  wrappingPrivateKey?: JsonWebKey;
  wrappingPublicKey?: JsonWebKey;
  credentials: Record<string, Credential>;
  operations: Record<string, { grantId: string; idempotencyKey: string }>;
  registryAccount?: RegistryAccount;
  setupFlow?: SetupFlow;
  slackSetup?: SlackSetup;
  reminders?: Partial<Record<string, boolean>>;
  reminderPending?: Partial<Record<string, boolean>>;
}

export interface DeviceClientOptions {
  origin: string;
  token?: string;
  /** The private journal. Its lock file is `${file}.lock`. */
  file: string;
  label?: string;
  log?: CellLog;
  /** Hold the journal lock for the client's lifetime; other writers wait or fail. */
  exclusive?: boolean;
  waitForLockMs?: number;
  signal?: AbortSignal;
  /** Fail instead of creating a new identity when the journal is missing. */
  existingOnly?: boolean;
}

export const REQUEST_TIMEOUT_MS = 25_000;

export class DeviceClient {
  readonly origin: string;
  token?: string;
  local!: Journal;
  protected readonly file: string;
  protected readonly label: string;
  protected readonly log: CellLog;
  protected readonly signal?: AbortSignal;
  private readonly exclusive: boolean;
  private readonly waitForLockMs: number;
  private readonly existingOnly: boolean;
  private releaseLock: (() => void) | null = null;
  private syncing: Promise<DeviceState> | null = null;
  private again = false;
  private stopped = false;

  constructor({
    origin,
    token,
    file,
    label = 'NanoClaw installation',
    log = () => {},
    exclusive = false,
    waitForLockMs = 0,
    signal,
    existingOnly = false,
  }: DeviceClientOptions) {
    const url = new URL(origin);
    const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' && !loopback)
    )
      throw new Error('Portal origin must use HTTPS, except on loopback.');
    this.origin = url.origin;
    this.token = token;
    this.file = file;
    this.label = label;
    this.log = log;
    this.exclusive = exclusive;
    this.waitForLockMs = waitForLockMs;
    this.signal = signal;
    this.existingOnly = existingOnly;
  }

  /** Load or create the journal. With `exclusive`, waits up to `waitForLockMs` for its lock. */
  async initialize(): Promise<this> {
    if (this.exclusive) {
      const deadline = Date.now() + this.waitForLockMs;
      while (!(this.releaseLock = await processLock(`${this.file}.lock`))) {
        if (Date.now() >= deadline)
          throw portalError(
            'Another setup or receiver owns this installation journal. Retry after it finishes.',
            'journal_busy',
          );
        await sleep(100, undefined, { signal: this.signal });
      }
    }
    try {
      const saved = await readJson<Partial<Journal>>(this.file);
      if (!saved) {
        if (this.existingOnly) throw portalError('Installation is not signed in.', 'installation_required');
        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        this.local = {
          privateKey: privateKey.export({ format: 'jwk' }),
          publicKey: publicKey.export({ format: 'jwk' }),
          credentials: {},
          operations: {},
        };
        await this.save();
      } else {
        if (!saved.privateKey) throw portalError('Installation state is incomplete.', 'installation_state_invalid');
        this.local = { credentials: {}, operations: {}, ...saved, privateKey: saved.privateKey };
      }
      if (this.local.origin && this.local.origin !== this.origin)
        throw new Error('This installation belongs to a different portal. Use a separate state file.');
      this.local.origin = this.origin;
      this.local.installId ||= randomUUID();
      if (!this.local.wrappingPrivateKey) {
        const pair = generateKeyPairSync('x25519');
        this.local.wrappingPrivateKey = pair.privateKey.export({ format: 'jwk' });
        this.local.wrappingPublicKey = pair.publicKey.export({ format: 'jwk' });
      }
      this.token ??= this.local.registryAccount?.token;
      await this.save();
      return this;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  save(): Promise<void> {
    return writePrivate(this.file, this.local);
  }

  /** A signed portal request. Non-2xx responses become errors carrying the portal's code and status. */
  async request<T = unknown>(
    method: string,
    route: string,
    body?: unknown,
    signal: AbortSignal | undefined = this.signal,
  ): Promise<T> {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const response = await fetch(`${this.origin}${route}`, {
      method,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        'content-type': 'application/json',
        ...deviceProof(this.local.privateKey, method, route, raw),
      },
      ...(raw ? { body: raw } : {}),
      signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]),
      redirect: 'error',
    });
    const result = (await response.json()) as T & { error?: string; message?: string };
    if (!response.ok)
      throw portalError(
        result.message || result.error || `The portal request failed (${response.status}).`,
        result.error,
        response.status,
      );
    return result;
  }

  /** Bring local credentials in line with the account's grants. Coalesces overlapping calls. */
  reconcile(): Promise<DeviceState> {
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.syncing = this.sync().finally(() => {
      this.syncing = null;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.reconcile().catch((error: unknown) => this.log({ event: 'retry', code: errorCodeOf(error) }));
      }
    });
    return this.syncing;
  }

  protected async sync(): Promise<DeviceState> {
    const state = await this.request<DeviceState>('GET', '/api/v1/device/state');
    const active = new Set(
      state.grants
        .filter((grant) => grant.desired === 'active' && Date.parse(grant.expiresAt) > Date.now())
        .map((grant) => grant.perk),
    );
    for (const perk of Object.keys(this.local.credentials)) {
      if (active.has(perk)) continue;
      delete this.local.credentials[perk];
      delete this.local.operations[perk];
      await this.save();
      this.log({ event: 'removed', perk });
    }
    for (const grant of state.grants) {
      if (!active.has(grant.perk)) continue;
      const redemption = grant.redemptions.find((r) => r.deviceId === this.local.deviceId);
      if (redemption && ['REVOKING', 'REVOKED'].includes(redemption.state ?? '')) continue;
      let credential = this.local.credentials[grant.perk];
      if (credential && redemption?.keyId === credential.keyId && redemption.operationId === credential.operationId) {
        if (redemption.state === 'DELIVERED') continue;
      } else {
        const previous = this.local.operations[grant.perk];
        if (!previous || previous.grantId !== grant.id) {
          this.local.operations[grant.perk] = { grantId: grant.id, idempotencyKey: random(24) };
          await this.save();
        }
        const result = await this.request<Credential>('POST', `/api/v1/grants/${grant.perk}/redeem`, {
          idempotencyKey: this.local.operations[grant.perk].idempotencyKey,
        });
        if (!result.secret) {
          this.log({ event: 'local_credential_missing', perk: grant.perk });
          continue;
        }
        credential = this.local.credentials[grant.perk] = result;
        await this.save();
        this.log({ event: 'stored', perk: grant.perk, resource: result.resource.label });
      }
      await this.request('POST', `/api/v1/grants/${grant.perk}/ack`, {
        operationId: credential.operationId,
        keyId: credential.keyId,
      });
    }
    return state;
  }

  /** Wait for an in-flight reconcile, then release the journal lock. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.syncing) await this.syncing.catch(() => undefined);
    if (this.releaseLock) {
      this.releaseLock();
      this.releaseLock = null;
    }
  }
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : 'unavailable';
}
