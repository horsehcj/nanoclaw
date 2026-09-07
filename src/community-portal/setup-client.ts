import { setTimeout as sleep } from 'node:timers/promises';
import { DeviceClient, type DeviceClientOptions, type RegistryAccount, type SetupFlow } from './device-client.js';
import { errorCode, errorStatus } from './errors.js';
import { openInstall, type InstallEnvelope } from './install-envelope.js';

/**
 * The setup wizard's side of a browser handoff: start a stage, print its link,
 * poll until the browser finishes, and receive the sealed installation
 * credential on first sign-in.
 */
export interface CatalogItem {
  id: string;
  kind: string;
  enabled?: boolean;
}

export interface SetupChoice {
  imageSource?: 'hardened' | 'local';
  workspaceId: string;
  name: string;
}

export interface SetupResult {
  id: string;
  status: string;
  deviceId?: string;
  choice: SetupChoice;
  envelope?: InstallEnvelope;
  [key: string]: unknown;
}

export interface SetupClientOptions extends DeviceClientOptions {
  /** Ask the portal to return to the terminal as soon as the perk is enabled. */
  autoContinue?: boolean;
}

const LIVE_FLOW_STATES = ['pending', 'authorizing', 'browsing', 'approved', 'awaiting_approval'];
const FINISHED_STATES = ['approved', 'awaiting_approval', 'skipped'];

export class SetupClient extends DeviceClient {
  flow?: SetupFlow;
  private readonly autoContinue: boolean;

  constructor({ autoContinue = false, ...options }: SetupClientOptions) {
    super(options);
    this.autoContinue = autoContinue;
  }

  /** Whether the release catalog offers `stage` (or, for `perks`, any partner) right now. */
  async available(stage: string): Promise<boolean> {
    const { items } = await this.request<{ items: CatalogItem[] }>('GET', '/api/v1/catalog');
    return items.some(
      (item) =>
        (stage === 'perks' ? item.kind !== 'account' : item.id === stage) &&
        (item.kind === 'account' || item.enabled === true),
    );
  }

  /** True when the signed-in installation already has `stage` enabled; never opens a browser. */
  async resumeEnabled(stage: string, name = 'Nano'): Promise<boolean> {
    if (!this.token) return false;
    try {
      await this.start(stage, name, { reuseEnabled: true });
      return true;
    } catch (error) {
      if (errorStatus(error) === 401) {
        await this.clearToken();
        return false;
      }
      if (['perk_not_enabled', 'installation_required'].includes(errorCode(error, ''))) return false;
      throw error;
    }
  }

  /** Start (or resume an unexpired) browser flow for `stage`. */
  async start(stage: string, name = 'Nano', { reuseEnabled = false } = {}): Promise<SetupFlow> {
    const previous = this.local.setupFlow;
    if (!reuseEnabled && previous?.stage === stage && Date.parse(previous.expiresAt) > Date.now()) {
      this.flow = previous;
      try {
        if (LIVE_FLOW_STATES.includes((await this.status()).status)) return previous;
      } catch (error) {
        const status = errorStatus(error);
        if (status !== 410 && status !== 401) throw error;
        if (status === 401) await this.clearToken();
      }
    }
    const body = {
      stage,
      name,
      reuseEnabled,
      autoContinue: this.autoContinue,
      installId: this.local.installId,
      label: this.label,
      publicKey: this.local.publicKey,
      wrappingKey: this.local.wrappingPublicKey,
    };
    try {
      this.flow = await this.request<SetupFlow>('POST', '/api/v1/setup/start', body);
    } catch (error) {
      if (reuseEnabled || errorStatus(error) !== 401 || !this.token) throw error;
      await this.clearToken();
      this.flow = await this.request<SetupFlow>('POST', '/api/v1/setup/start', body);
    }
    this.local.installId = this.flow.installId;
    this.flow.stage = stage;
    this.local.setupFlow = this.flow;
    await this.save();
    return this.flow;
  }

  status(): Promise<SetupResult> {
    return this.request<SetupResult>('GET', `/api/v1/setup/${this.currentFlow().code}`);
  }

  async clearToken(): Promise<void> {
    this.token = undefined;
    delete this.local.registryAccount;
    this.local.credentials = {};
    await this.save();
  }

  /** Poll the flow until the browser finishes it, unsealing the installation credential if one arrives. */
  async wait({ pollMs = 1500, onState = (_state: SetupResult): void => {} } = {}): Promise<SetupResult> {
    const flow = this.currentFlow();
    while (Date.now() < Date.parse(flow.expiresAt)) {
      let result: SetupResult;
      try {
        result = await this.status();
      } catch (error) {
        const status = errorStatus(error);
        if (status && status < 500 && status !== 429) throw error;
        await sleep(pollMs);
        continue;
      }
      onState(result);
      if (FINISHED_STATES.includes(result.status)) {
        if (result.envelope) {
          if (!this.local.wrappingPrivateKey)
            throw new Error('This installation has no wrapping key. Restart this step.');
          const account = openInstall<RegistryAccount>(
            this.local.wrappingPrivateKey,
            `${flow.id}:${this.local.installId}`,
            result.envelope,
          );
          if (!account.token || !account.account_id || account.install_id !== this.local.installId)
            throw new Error('Invalid installation credential');
          this.local.registryAccount = account;
          await this.save();
          this.token = account.token;
        }
        if (result.status !== 'skipped' || this.token) {
          this.local.deviceId = result.deviceId;
          await this.save();
        }
        delete result.envelope;
        return result;
      }
      if (['cancelled', 'failed'].includes(result.status))
        throw new Error('Setup was cancelled or failed. Restart this step.');
      await sleep(pollMs);
    }
    throw new Error('Browser setup timed out. Restart this step to get a new link.');
  }

  complete(status = 'complete', detail: Record<string, unknown> = {}): Promise<unknown> {
    return this.request('POST', `/api/v1/setup/${this.currentFlow().code}/complete`, { status, ...detail });
  }

  private currentFlow(): SetupFlow {
    if (!this.flow) throw new Error('Start a setup stage before polling it.');
    return this.flow;
  }
}
