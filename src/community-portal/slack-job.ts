import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Journal } from './device-client.js';
import { SetupClient } from './setup-client.js';
import { isErrno } from './errors.js';
import { readJson, writePrivate } from './private-file.js';
import { processLock, processLockOwner } from './process-lock.js';

/**
 * The saved Slack installation job (`data/slack-install.json`). Setup writes
 * it after the browser hands over a managed app; a detached worker
 * (setup/slack-worker.ts) finishes the install once the workspace approves,
 * and the running host resumes that worker after a restart. The job carries
 * an immutable snapshot of the installation identity so the worker never
 * opens the foreground setup journal.
 */
/** Mirrors OperatorRole in setup/lib/role-prompt.ts. */
export type SlackOperatorRole = 'owner' | 'admin' | 'member';

export interface SlackJob {
  id: string;
  status: 'awaiting_approval' | 'installing' | 'complete' | 'failed' | 'expired';
  createdAt: string;
  expiresAt: string;
  setupId: string;
  origin: string;
  serviceBase: string;
  identity: Pick<Journal, 'privateKey' | 'registryAccount' | 'deviceId'>;
  app: { appId: string; appToken: string; botToken?: string };
  deliveryId?: string;
  acknowledged?: boolean;
  context: {
    agentName: string;
    displayName: string;
    role: SlackOperatorRole;
    ownerHandle: string;
    templateAgentId?: string;
  };
  error?: string;
  reportedStatus?: string;
}

const JOB_STATUSES: readonly string[] = ['awaiting_approval', 'installing', 'complete', 'failed', 'expired'];
const APPROVAL_WINDOW_MS = 7 * 86_400_000;
export const DEFAULT_SLACK_SERVICE = 'https://slack.nanoclaw.dev';

export const slackJobFile = (root = process.cwd()): string => path.join(root, 'data/slack-install.json');

export function readSlackJob(root = process.cwd()): Promise<SlackJob | null> {
  return readJson<SlackJob>(slackJobFile(root));
}

/** Public progress only; an abandoned or expired job must not look active. */
export function slackJobStatus(job: SlackJob | null, now = Date.now()): SlackJob['status'] | undefined {
  if (!job) return undefined;
  if (!JOB_STATUSES.includes(job.status)) return 'failed';
  if (['awaiting_approval', 'installing'].includes(job.status) && !(Date.parse(job.expiresAt) > now)) return 'expired';
  return job.status;
}

/**
 * Serialize checkout mutations between foreground setup and the worker. A
 * child spawned by the holder inherits the claim through NANOCLAW_SETUP_LOCK.
 */
export async function withSetupLock<T>(run: () => Promise<T>, root = process.cwd()): Promise<T> {
  const file = path.join(root, 'data/setup-mutation.lock');
  const inherited = process.env.NANOCLAW_SETUP_LOCK;
  if (inherited && processLockOwner(file)?.nonce === inherited) return run();
  let release: (() => void) | null;
  while (!(release = await processLock(file))) await sleep(1000);
  process.env.NANOCLAW_SETUP_LOCK = processLockOwner(file)?.nonce;
  try {
    return await run();
  } finally {
    delete process.env.NANOCLAW_SETUP_LOCK;
    release();
  }
}

/** Start the detached worker for a saved job that still has work to do. */
export async function launchSlackJob(root = process.cwd()): Promise<boolean> {
  const job = await readSlackJob(root);
  if (
    !job ||
    !(
      ['awaiting_approval', 'installing'].includes(job.status) ||
      (job.status === 'complete' && job.reportedStatus !== 'complete')
    )
  )
    return false;
  // The host supervisor may check on every cell update. A healthy owner is
  // already polling Slack; do not spawn a losing process for each check.
  if (processLockOwner(`${slackJobFile(root)}.lock`)) return false;
  const env = { ...process.env };
  delete env.NANOCLAW_SETUP_LOCK;
  delete env.NANOCLAW_TEMPLATE_AGENT_ID;
  // The worker applies the Slack channel skill, so it lives with the wizard
  // and runs through tsx like every other setup entry point.
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'setup/slack-worker.ts')], {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The Slack background worker could not start. Resume the Slack setup step.'));
    }, 10_000);
    child.once('message', (message) => {
      if ((message as { type?: string } | null)?.type !== 'slack-worker-ready') return;
      clearTimeout(timer);
      resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('The Slack background worker failed to start. Resume the Slack setup step.'));
    });
  });
  child.unref();
  return true;
}

/** Persist the app the browser handed over as a job, then start its worker. */
export async function queueSlackJob(context: SlackJob['context'], root = process.cwd()): Promise<void> {
  let local: Journal;
  try {
    local = JSON.parse(await readFile(path.join(root, 'data/community-portal.json'), 'utf8')) as Journal;
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
    throw new Error('Slack credentials were not saved. Restart the Slack step.', { cause: error });
  }
  const saved = local.slackSetup;
  if (!saved?.app?.appToken || !local.registryAccount?.token || !local.origin)
    throw new Error('Slack credentials were not saved. Restart the Slack step.');
  const app = saved.app;
  const prior = await readSlackJob(root);
  const samePrior = prior?.app.appId === app.appId ? prior : null;
  if (prior && !samePrior && ['awaiting_approval', 'installing'].includes(prior.status))
    throw new Error('A Slack installation is already running in this checkout.');
  if (!samePrior || ['failed', 'expired'].includes(samePrior.status)) {
    const job: SlackJob = {
      id: randomUUID(),
      status: app.botToken ? 'installing' : 'awaiting_approval',
      createdAt: new Date().toISOString(),
      expiresAt: samePrior ? samePrior.expiresAt : new Date(Date.now() + APPROVAL_WINDOW_MS).toISOString(),
      setupId: saved.setupId,
      origin: local.origin,
      serviceBase: saved.serviceBase || DEFAULT_SLACK_SERVICE,
      identity: { privateKey: local.privateKey, registryAccount: local.registryAccount, deviceId: local.deviceId },
      app: samePrior ? samePrior.app : app,
      context,
      ...(samePrior ? { deliveryId: samePrior.deliveryId, acknowledged: samePrior.acknowledged } : {}),
    };
    await writePrivate(slackJobFile(root), job);
  }
  await launchSlackJob(root);
}

/** A client over the job's credential snapshot; never touches the foreground journal. */
export function slackProgressClient(job: SlackJob): SetupClient {
  const client = new SetupClient({
    origin: job.origin,
    file: '',
    label: '',
    token: job.identity.registryAccount?.token,
  });
  client.local = { ...job.identity, credentials: {}, operations: {} };
  return client;
}
