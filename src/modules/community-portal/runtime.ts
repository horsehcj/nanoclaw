import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  CellConnection,
  type CellEvent,
  type CellTicket,
  DeviceClient,
  errorCode,
  errorStatus,
  type Journal,
  portalError,
  processLock,
  readJson,
} from '../../community-portal/index.js';
import { launchSlackJob, readSlackJob } from '../../community-portal/slack-job.js';

/**
 * Keeps a running host connected to its account cell for as long as the
 * checkout is signed in. One connection per checkout, guarded by
 * `data/community-portal-runtime.lock`. The journal is read without taking
 * its lock so the connection survives while foreground setup owns it; every
 * write goes through a locked DeviceClient. Cell notifications only trigger a
 * fresh read of locally saved, authorized work: reconciling perk credentials
 * and resuming the saved Slack install worker.
 */
export interface PortalRuntimeOptions {
  root?: string;
  signal?: AbortSignal;
  log?: (event: CellEvent) => void;
  intervalMs?: number;
}

type Identity = Pick<Journal, 'origin' | 'installId' | 'deviceId' | 'privateKey'> & {
  origin: string;
  registryAccount: NonNullable<Journal['registryAccount']>;
};

const RECONCILE_INTERVAL_MS = 60_000;

export function startPortalRuntime({
  root = process.cwd(),
  signal,
  log = () => {},
  intervalMs = 5000,
}: PortalRuntimeOptions = {}): { stop(): Promise<void> } {
  const abort = new AbortController();
  const file = path.join(root, 'data/community-portal.json');
  let connection: CellConnection | undefined;
  let identity: Identity | undefined;
  let rejected = false;
  let release: (() => void) | null = null;
  let pending: Promise<void> | undefined;
  let again = false;
  let dirty = true;
  let nextSync = 0;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  let lastError = '';
  const denied = (error: unknown): boolean => [401, 403].includes(errorStatus(error) ?? 0);
  const rejectIdentity = (): void => {
    if (!rejected) log({ event: 'sign_in_required' });
    rejected = true;
    dirty = true;
    connection?.stop();
    wake();
  };

  async function check(): Promise<void> {
    release ||= await processLock(path.join(root, 'data/community-portal-runtime.lock'));
    if (!release || stopped) return;
    const local = await readJson<Partial<Journal>>(file);
    if (
      local?.registryAccount?.token &&
      (!local.installId ||
        local.installId !== local.registryAccount.install_id ||
        !local.deviceId ||
        !local.privateKey ||
        !local.origin)
    ) {
      connection?.stop();
      connection = undefined;
      identity = undefined;
      throw portalError('Installation state is incomplete.', 'installation_state_invalid');
    }
    const current: Identity | undefined =
      local?.registryAccount?.token && local.deviceId && local.privateKey && local.origin
        ? {
            origin: local.origin,
            installId: local.installId,
            deviceId: local.deviceId,
            privateKey: local.privateKey,
            registryAccount: local.registryAccount,
          }
        : undefined;
    if (!isDeepStrictEqual(current, identity)) {
      connection?.stop();
      connection = undefined;
      identity = current;
      rejected = false;
      dirty = true;
      if (current) {
        const proof = new DeviceClient({
          origin: current.origin,
          token: current.registryAccount.token,
          file,
          signal: abort.signal,
        });
        proof.local = { ...current, credentials: {}, operations: {} };
        connection = new CellConnection({
          origin: proof.origin,
          getTicket: async (requestSignal) => {
            try {
              return await proof.request<CellTicket>('POST', '/api/v1/cell-ticket', {}, requestSignal);
            } catch (error) {
              if (denied(error) && isDeepStrictEqual(identity, current)) rejectIdentity();
              throw error;
            }
          },
          onChange: () => {
            dirty = true;
            wake();
          },
          log: (event) => log({ ...event, deviceId: current.deviceId }),
        });
        connection.start();
      }
    }
    if (!current || stopped) return;
    const job = await readSlackJob(root);
    // Supervise only the saved installation bound to this account/checkout.
    // A live worker keeps its existing approval polling; no duplicate spawns.
    if (
      !rejected &&
      job &&
      job.identity.deviceId === current.deviceId &&
      job.identity.registryAccount?.install_id === current.installId &&
      job.identity.registryAccount?.account_id === current.registryAccount.account_id &&
      job.origin === current.origin
    ) {
      if (await launchSlackJob(root)) log({ event: 'slack_install_resumed', deviceId: current.deviceId });
    }
    if (stopped || (!dirty && Date.now() < nextSync)) return;
    const client = new DeviceClient({
      origin: current.origin,
      file,
      exclusive: true,
      existingOnly: true,
      signal: abort.signal,
      log,
    });
    try {
      await client.initialize();
      // The CLI may have changed identity while we acquired the journal.
      if (client.local.deviceId !== current.deviceId || client.token !== current.registryAccount.token) return;
      if (rejected) {
        client.local.credentials = {};
        client.local.operations = {};
        await client.save();
        dirty = false;
        nextSync = Infinity;
        return;
      }
      dirty = false;
      await client.reconcile();
      nextSync = Date.now() + RECONCILE_INTERVAL_MS;
    } catch (error) {
      if (errorCode(error, '') === 'journal_busy') return;
      if (denied(error)) {
        rejectIdentity();
        if (client.local) {
          client.local.credentials = {};
          client.local.operations = {};
          await client.save();
        }
        return;
      }
      dirty = true;
      throw error;
    } finally {
      await client.stop();
    }
  }

  function wake(): void {
    if (stopped) return;
    if (pending) {
      again = true;
      return;
    }
    pending = check()
      .then(() => {
        lastError = '';
      })
      .catch((error: unknown) => {
        if (stopped) return;
        const code = errorCode(error);
        if (code !== lastError) log({ event: 'runtime_retry', code });
        lastError = code;
      })
      .finally(() => {
        pending = undefined;
        if (again) {
          again = false;
          wake();
        }
      });
  }

  const timer = setInterval(wake, intervalMs);
  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopped = true;
    abort.abort();
    clearInterval(timer);
    connection?.stop();
    signal?.removeEventListener('abort', onAbort);
    stopping = (async () => {
      await pending;
      release?.();
      release = null;
    })();
    return stopping;
  }
  const onAbort = (): void => {
    void stop();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) void stop();
  else wake();
  return { stop };
}
