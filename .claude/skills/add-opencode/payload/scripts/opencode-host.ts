// This module also loads directly from the skill before runtime installation.
// Runtime imports may use only Node and NanoClaw's existing host dependencies.
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';

import type { HostHarness } from '../setup/providers/host-harness-contract.js';

export const OPENCODE_HOST_INSTALL_VERSION = '1.18.25';

function managedBinary(root: string): string {
  return path.join(root, 'data', 'host-harness', 'opencode', 'node_modules', '.bin', 'opencode');
}

function version(binary: string, root: string): string | undefined {
  const result = spawnSync(binary, ['--version'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0 ? result.stdout.trim().match(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/m)?.[0] : undefined;
}

export function findHostOpenCode(root: string): { binary: string; version: string } | undefined {
  const paths = [
    managedBinary(root),
    ...(process.env.PATH ?? '')
      .split(path.delimiter)
      .filter((item) => path.isAbsolute(item))
      .map((item) => path.join(item, 'opencode')),
    path.join(os.homedir(), '.opencode', 'bin', 'opencode'),
    path.join(os.homedir(), '.local', 'bin', 'opencode'),
  ];
  for (const binary of new Set(paths)) {
    if (!fs.existsSync(binary)) continue;
    const installed = version(binary, root);
    if (installed) return { binary, version: installed };
  }
  return undefined;
}

function run(binary: string, args: string[], root: string): Promise<'exited' | 'failed'> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { cwd: root, stdio: 'inherit' });
    child.once('error', () => resolve('failed'));
    child.once('close', (code) => resolve(code === 0 ? 'exited' : 'failed'));
  });
}

export const hostHarness: HostHarness = {
  seamVersion: 1,
  label: 'OpenCode',
  async prepare(root) {
    const existing = findHostOpenCode(root);
    if (existing) {
      p.log.info(`Host OpenCode ${existing.version} is available. Its native configuration is preserved.`);
      return 'available';
    }
    const want = await p.confirm({
      message: `Install OpenCode ${OPENCODE_HOST_INSTALL_VERSION} on this host for maintenance?`,
      initialValue: true,
    });
    if (p.isCancel(want) || !want) return 'declined';
    const prefix = path.dirname(path.dirname(path.dirname(managedBinary(root))));
    fs.mkdirSync(prefix, { recursive: true, mode: 0o700 });
    // Suppress dependency lifecycle scripts, then run only this pinned package's
    // installer to link its native executable. Keep the installation local.
    const installed = await run(
      'npm',
      [
        'install',
        '--prefix',
        prefix,
        '--no-save',
        '--package-lock=false',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        `opencode-ai@${OPENCODE_HOST_INSTALL_VERSION}`,
      ],
      root,
    );
    const linked =
      installed === 'exited'
        ? await run(process.execPath, [path.join(prefix, 'node_modules', 'opencode-ai', 'postinstall.mjs')], root)
        : 'failed';
    if (linked !== 'exited' || version(managedBinary(root), root) !== OPENCODE_HOST_INSTALL_VERSION) {
      p.log.warn('Host OpenCode installation failed. Retry with pnpm run maintain -- --configure.');
      return 'unavailable';
    }
    return 'available';
  },
  async configure(root) {
    const binary = findHostOpenCode(root)?.binary;
    if (!binary) return 'failed';
    p.note(
      [
        'OpenCode on the host uses its own native credentials and model configuration.',
        'In OpenCode, use /connect to sign in, then /models to choose a model.',
        'For a custom endpoint, follow https://opencode.ai/docs/providers/#custom-provider.',
        'NanoClaw container credentials remain in OneCLI. Host maintenance works independently of that gateway.',
        'Exit OpenCode to return here.',
      ].join('\n'),
      'Configure host OpenCode',
    );
    // A TUI supports native API keys, browser/device OAuth, and keyless models.
    // Returning from it proves only that the CLI ran, not account entitlement.
    return run(binary, [], root);
  },
  async launch(root, contextFile) {
    const binary = findHostOpenCode(root)?.binary;
    if (!binary) return 'failed';
    const args = contextFile
      ? ['--prompt', `Read ${JSON.stringify(contextFile)} and follow the maintenance request inside it.`]
      : [];
    return run(binary, args, root);
  },
};
