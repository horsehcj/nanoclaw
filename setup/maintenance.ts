import path from 'path';
import { pathToFileURL } from 'url';

import * as p from '@clack/prompts';

import { readEnvFile } from '../src/env.js';
import { getHostMaintenanceProvider, loadHostHarness, offerHostMaintenance } from './lib/host-maintenance.js';
import { listProviderDescriptors } from './providers/skill-descriptor.js';
import { upsertEnvVar } from './set-env.js';

function hostOptions() {
  return [
    { value: 'claude', label: 'Claude Code' },
    ...listProviderDescriptors()
      .filter((entry) => entry.hostHarnessModule)
      .map((entry) => ({ value: entry.value, label: entry.label })),
    { value: 'none', label: 'Skip host assistance' },
  ];
}

async function configureNativeHost(provider: string, mode: 'offer' | 'open' | 'skip'): Promise<void> {
  try {
    const harness = await loadHostHarness(provider);
    if (!harness || (await harness.prepare(process.cwd())) !== 'available') return;
    if (mode === 'skip') return;
    const configure =
      mode === 'offer'
        ? await p.confirm({ message: `Configure a host model connection in ${harness.label} now?`, initialValue: true })
        : true;
    if (!p.isCancel(configure) && configure && (await harness.configure(process.cwd())) === 'failed') {
      p.log.warn('Host configuration did not finish. Retry with pnpm run maintain -- --configure.');
    }
  } catch (error) {
    p.log.warn(
      `Host maintenance is unavailable: ${error instanceof Error ? error.message : String(error)}. Setup can continue; retry with pnpm run maintain -- --configure.`,
    );
  }
}

/** Select the host assistant before Docker, the runtime payload, and OneCLI. */
export async function selectHostMaintenance(runtimeProvider?: string): Promise<void> {
  if (process.env.NANOCLAW_SKIP_HOST_ASSIST === '1' || process.env.NANOCLAW_SKIP_CLAUDE_ASSIST === '1') return;
  const saved = readEnvFile(['HOST_HARNESS_PROVIDER']);
  if (process.env.NANOCLAW_HOST_PROVIDER?.trim() || saved.HOST_HARNESS_PROVIDER) {
    await configureNativeHost(getHostMaintenanceProvider(), saved.HOST_HARNESS_PROVIDER ? 'skip' : 'offer');
    return;
  }
  const options = hostOptions();
  const preferred = runtimeProvider ?? getHostMaintenanceProvider();
  const selected = await p.select({
    message: 'Which coding agent should help maintain this installation?',
    options,
    initialValue: options.some((entry) => entry.value === preferred) ? preferred : 'claude',
  });
  if (p.isCancel(selected)) throw new Error('Host maintenance selection cancelled');
  upsertEnvVar('HOST_HARNESS_PROVIDER', selected);
  process.env.NANOCLAW_HOST_PROVIDER = selected;
  await configureNativeHost(selected, 'offer');
}

export async function run(args: string[]): Promise<void> {
  args = args.filter((arg) => arg !== '--');
  if (args.some((arg) => !['--configure', '--update', '--debug'].includes(arg)) || args.length > 1) {
    throw new Error('Usage: pnpm run maintain -- [--configure|--update|--debug]');
  }
  if (args[0] === '--configure') {
    // An explicit configuration invocation reopens the choice without deleting
    // saved state; cancellation keeps the existing selection intact.
    const options = hostOptions();
    const previous = getHostMaintenanceProvider();
    const choice = await p.select({
      message: 'Host coding agent',
      options,
      initialValue: options.some((entry) => entry.value === previous) ? previous : 'claude',
    });
    if (p.isCancel(choice)) return;
    upsertEnvVar('HOST_HARNESS_PROVIDER', choice);
    process.env.NANOCLAW_HOST_PROVIDER = choice;
    if (choice === 'claude') await (await import('./lib/claude-assist.js')).ensureClaudeReady(process.cwd());
    else await configureNativeHost(choice, 'open');
    return;
  }
  const task = args[0] === '--update' ? 'update-nanoclaw' : args[0] === '--debug' ? 'debug' : undefined;
  const request = task
    ? `Read and follow .claude/skills/${task}/SKILL.md in this checkout. Use ordinary conversation for decisions and respect all confirmations in the skill.`
    : 'Help maintain this NanoClaw checkout. Read its project instructions, ask what the operator needs, and use the relevant .claude/skills/ workflow.';
  const native = await offerHostMaintenance(request, process.cwd(), true);
  if (native === undefined) {
    const provider = getHostMaintenanceProvider();
    if (provider === 'claude') {
      await (await import('./lib/claude-handoff.js')).offerClaudeMaintenance(request, process.cwd());
    } else {
      p.log.warn(`${provider} does not declare host maintenance. Run pnpm run maintain -- --configure.`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
