import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import * as p from '@clack/prompts';

import { readEnvFile } from '../../src/env.js';
import { getProviderDescriptor, listProviderDescriptors } from '../providers/skill-descriptor.js';
import { assertHostHarness, type HostHarness } from '../providers/host-harness-contract.js';
import { getPickedProvider } from './picked-provider.js';

/** Host choice is install-wide. Switching an agent group never changes it. */
export function getHostMaintenanceProvider(root = process.cwd()): string {
  const saved = readEnvFile(['HOST_HARNESS_PROVIDER', 'DEFAULT_AGENT_PROVIDER'], root);
  return (
    process.env.NANOCLAW_HOST_PROVIDER?.trim() ||
    saved.HOST_HARNESS_PROVIDER ||
    getPickedProvider() ||
    process.env.NANOCLAW_AGENT_PROVIDER?.trim() ||
    saved.DEFAULT_AGENT_PROVIDER ||
    'claude'
  ).toLowerCase();
}

const loaded = new Map<string, Promise<HostHarness | undefined>>();

/** One authoritative bundled module per provider/root, including after skill apply. */
export function loadHostHarness(provider: string, root = process.cwd()): Promise<HostHarness | undefined> {
  const key = `${path.resolve(root)}\0${provider}`;
  let result = loaded.get(key);
  if (!result) {
    result = load(provider, root);
    loaded.set(key, result);
    // A transient missing file must remain recoverable after repairing the checkout.
    result.catch(() => loaded.delete(key));
  }
  return result;
}

async function load(provider: string, root: string): Promise<HostHarness | undefined> {
  const descriptor = getProviderDescriptor(provider, root);
  if (!descriptor?.hostHarnessModule) return undefined;
  const checkout = fs.realpathSync(root);
  const skill = fs.realpathSync(path.join(root, descriptor.skillDir));
  const module = fs.realpathSync(path.join(skill, descriptor.hostHarnessModule));
  if (
    !skill.startsWith(`${checkout}${path.sep}`) ||
    !module.startsWith(`${skill}${path.sep}`) ||
    !fs.statSync(module).isFile()
  ) {
    throw new Error('Host harness module must be a regular file inside its checkout skill');
  }
  const exports = await import(pathToFileURL(module).href);
  assertHostHarness(exports.hostHarness);
  return exports.hostHarness;
}

export async function verifyHostHarnessDeclarations(root = process.cwd()): Promise<string[]> {
  const declared: string[] = [];
  for (const provider of listProviderDescriptors(root)) {
    if (!provider.hostHarnessModule) continue;
    await loadHostHarness(provider.value, root);
    declared.push(provider.value);
  }
  return declared;
}

/** undefined means a legacy provider: caller retains its existing guarded path. */
export async function offerHostMaintenance(
  context: string,
  root = process.cwd(),
  userRequested = false,
): Promise<boolean | undefined> {
  if (process.env.NANOCLAW_SKIP_HOST_ASSIST === '1' || process.env.NANOCLAW_SKIP_CLAUDE_ASSIST === '1') return false;
  const provider = getHostMaintenanceProvider(root);
  if (provider === 'none') return false;
  let harness: HostHarness | undefined;
  try {
    harness = await loadHostHarness(provider, root);
  } catch (error) {
    p.log.warn(
      `${provider} host assistance is unavailable: ${error instanceof Error ? error.message : String(error)}. See logs/setup.log.`,
    );
    return false;
  }
  if (!harness) return undefined;
  if (!userRequested) {
    const want = await p.confirm({ message: `Want to debug this with ${harness.label}?`, initialValue: true });
    if (p.isCancel(want) || !want) return false;
  }
  let directory: string | undefined;
  try {
    if ((await harness.prepare(root)) !== 'available') return false;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-host-help-'));
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, 'context.md');
    fs.writeFileSync(file, context, { mode: 0o600 });
    p.log.info(
      `Opening ${harness.label} in this checkout. Configure a host model connection if prompted; exit to return to setup.`,
    );
    const outcome = await harness.launch(root, file);
    if (outcome !== 'exited') {
      p.log.warn(`${harness.label} exited unsuccessfully. The original failure remains in logs/setup.log.`);
      return false;
    }
    p.log.info('Back from host assistance. Retry the failed step to verify any repair.');
    return true;
  } catch (error) {
    p.log.warn(
      `Host assistance could not start: ${error instanceof Error ? error.message : String(error)}. See logs/setup.log.`,
    );
    return false;
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
}
