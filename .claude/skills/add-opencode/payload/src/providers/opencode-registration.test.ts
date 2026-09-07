import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../config.js', async (original) => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-host-'));
  return { ...(await original<typeof import('../config.js')>()), DATA_DIR: fixture.root };
});
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }));
import './index.js';
import '../provider-contracts/index.js';
import { getProviderContainerConfig } from './provider-container-registry.js';
import { getProviderHostContract } from '../provider-contracts/registry.js';
import { buildOneCliManagedStub } from './opencode-auth-stub.js';

afterAll(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
function context(hostEnv: NodeJS.ProcessEnv = {}) {
  return {
    sessionDir: path.join(fixture.root, 'session'),
    groupDir: path.join(fixture.root, 'group'),
    agentGroupId: 'test',
    selectedSkills: [],
    hostEnv,
    coreOwnsProviderSurfaces: true as const,
  };
}
function writeStub(stub: unknown) {
  const file = path.join(fixture.root, 'opencode', 'openai-auth-stub.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(stub));
  return file;
}
describe('OpenCode host payload', () => {
  it('keeps the installed CLI and SDK on the same supported exact pin', () => {
    const tools = JSON.parse(fs.readFileSync(new URL('../../container/cli-tools.json', import.meta.url), 'utf8'));
    const runner = JSON.parse(
      fs.readFileSync(new URL('../../container/agent-runner/package.json', import.meta.url), 'utf8'),
    );
    expect(tools.find((entry: { name: string }) => entry.name === 'opencode-ai')).toMatchObject({
      version: '1.18.25',
      onlyBuilt: true,
    });
    expect(runner.dependencies['@opencode-ai/sdk']).toBe('1.18.25');
  });
  it('registers the implementation and version 2 surfaces through the actual barrels', () => {
    expect(getProviderContainerConfig('opencode')).toBeTypeOf('function');
    expect(getProviderHostContract('opencode')).toMatchObject({
      seamVersion: 2,
      readOnlyFileMounts: [{ volumeId: 'opencode-xdg', relativePath: 'opencode/auth.json' }],
    });
  });
  it('passes backend defaults and preserves proxy exclusions without doing core filesystem work', async () => {
    const contribution = await getProviderContainerConfig('opencode')!(
      context({
        OPENCODE_PROVIDER: 'openai',
        OPENCODE_MODEL: 'openai/test-model',
        NO_PROXY: 'internal.example',
        no_proxy: 'lower.example',
        ANTHROPIC_BASE_URL: 'http://localhost:8891/v1',
      }),
    );
    expect(contribution.env).toMatchObject({
      OPENCODE_MODEL: 'openai/test-model',
      NO_PROXY: 'internal.example,127.0.0.1,localhost',
      no_proxy: 'lower.example,127.0.0.1,localhost',
    });
    expect(contribution.mounts).toEqual([]);
    expect(fs.existsSync(context().sessionDir)).toBe(false);
  });
  it('selects only the fixed sentinel auth file when ChatGPT mode is enabled', async () => {
    const file = writeStub(buildOneCliManagedStub());
    const contribution = await getProviderContainerConfig('opencode')!(context({ OPENCODE_AUTH_MODE: 'chatgpt' }));
    expect(contribution.mounts).toEqual([
      { hostPath: file, containerPath: '/opencode-xdg/opencode/auth.json', readonly: true },
    ]);
    expect(fs.existsSync(context().sessionDir)).toBe(false);
  });
  it('rejects a native OAuth file or unexpected token field instead of mounting it', async () => {
    for (const stub of [
      { openai: { type: 'oauth', access: 'live-token', refresh: 'live-refresh' } },
      { openai: { ...(buildOneCliManagedStub().openai as object), idToken: 'unexpected-secret' } },
    ]) {
      writeStub(stub);
      expect(() => getProviderContainerConfig('opencode')!(context({ OPENCODE_AUTH_MODE: 'chatgpt' }))).toThrow(
        'stub is invalid',
      );
    }
  });
});
