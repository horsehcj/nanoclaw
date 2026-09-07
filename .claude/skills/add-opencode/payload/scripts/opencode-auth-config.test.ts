import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  writes: [] as Array<[string, string | null]>,
  requests: [] as RequestInit[],
  failVault: false,
  cancelPassword: false,
  existing: false,
  backend: 'openrouter',
  key: 'fixture-key',
  writesAtVault: -1,
  passwords: 0,
}));
vi.mock('../setup/lib/bright-select.js', () => ({
  brightSelect: async ({ message }: { message: string }) =>
    message.includes('backend') ? fixture.backend : 'openrouter/fixture',
}));
vi.mock('@clack/prompts', () => ({
  isCancel: (value: unknown) => typeof value === 'symbol',
  cancel: () => {
    throw new Error('cancelled');
  },
  text: async () => 'openrouter/fixture',
  password: async () => {
    fixture.passwords++;
    return fixture.cancelPassword ? Symbol('cancel') : fixture.key;
  },
  log: { success: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../setup/logs.js', () => ({ userInput: vi.fn(), step: vi.fn() }));
vi.mock('../setup/set-env.js', () => ({
  upsertEnvVar: (key: string, value: string) => fixture.writes.push([key, value]),
  removeEnvVar: (key: string) => fixture.writes.push([key, null]),
}));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<object>()),
  ONECLI_URL: 'https://configured-vault.example',
}));
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  execFileSync: () => {
    throw new Error('catalog unavailable');
  },
}));
import { runOpenCodeAuthStep, runOpenCodeSetupAuth } from './opencode-auth.js';

beforeEach(() => {
  Object.assign(fixture, {
    writes: [],
    requests: [],
    failVault: false,
    cancelPassword: false,
    existing: false,
    backend: 'openrouter',
    key: 'fixture-key',
    writesAtVault: -1,
    passwords: 0,
  });
  for (const key of [
    'OPENCODE_PROVIDER',
    'OPENCODE_MODEL',
    'OPENCODE_SMALL_MODEL',
    'OPENCODE_BASE_URL',
    'OPENCODE_AUTH_MODE',
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv('ONECLI_URL', 'https://configured-vault.example');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, request: RequestInit) => {
      fixture.requests.push(request);
      fixture.writesAtVault = fixture.writes.length;
      if (fixture.failVault) throw new Error('private-transport-detail');
      return new Response(
        JSON.stringify(
          request.method === 'GET'
            ? fixture.existing
              ? [
                  {
                    id: 'granted-id',
                    name: 'OpenCode openrouter',
                    type: 'generic',
                    hostPattern: 'openrouter.ai',
                    scope: 'project',
                    valueSource: 'inline',
                    pathPattern: null,
                    injectionConfig: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
                  },
                ]
              : []
            : { id: 'created-id', success: true, preview: 'private-preview' },
        ),
      );
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('OpenCode auth configuration commit', () => {
  it('vaults before writing only provider-owned defaults and never invokes the global CLI', async () => {
    await runOpenCodeAuthStep();
    expect(fixture.writesAtVault).toBe(0);
    expect(fixture.requests.map((request) => request.method)).toEqual(['GET', 'GET', 'POST']);
    expect(JSON.parse(fixture.requests.at(-1)!.body as string).value).toBe('fixture-key');
    expect(fixture.writes).toContainEqual(['OPENCODE_BASE_URL', 'native']);
    expect(fixture.writes.every(([key]) => key.startsWith('OPENCODE_'))).toBe(true);
  });
  it('preserves defaults and does not request a key when metadata is unavailable', async () => {
    fixture.failVault = true;
    await expect(runOpenCodeAuthStep()).rejects.toThrow('Could not confirm');
    expect(fixture.writes).toEqual([]);
    expect(fixture.passwords).toBe(0);
  });
  it('preserves defaults and the vault when the password prompt is cancelled', async () => {
    fixture.cancelPassword = true;
    await expect(runOpenCodeAuthStep()).rejects.toThrow('cancelled');
    expect(fixture.writes).toEqual([]);
    expect(fixture.requests.map((request) => request.method)).toEqual(['GET']);
  });
  it('keeps the existing credential on a blank key and rotates its ID on replacement', async () => {
    fixture.existing = true;
    fixture.key = '';
    await runOpenCodeAuthStep();
    expect(fixture.requests.map((request) => request.method)).toEqual(['GET', 'GET']);
    fixture.key = 'replacement-fixture';
    fixture.requests = [];
    await runOpenCodeAuthStep();
    expect(fixture.requests.map((request) => request.method)).toEqual(['GET', 'GET', 'PATCH']);
  });
  it.each(['OPENCODE_PROVIDER', 'OPENCODE_MODEL', 'OPENCODE_SMALL_MODEL', 'OPENCODE_BASE_URL', 'OPENCODE_AUTH_MODE'])(
    'refuses an exported %s conflict before requesting or saving credentials',
    async (name) => {
      vi.stubEnv(name, 'conflicting-value');
      await expect(runOpenCodeAuthStep()).rejects.toThrow(`exported ${name}`);
      expect(fixture.requests).toEqual([]);
      expect(fixture.writes).toEqual([]);
    },
  );
  it('cannot silently skip authentication when called by setup', async () => {
    fixture.backend = 'skip';
    await expect(runOpenCodeSetupAuth()).rejects.toThrow('requires a configured backend');
    expect(fixture.writes).toEqual([]);
    expect(fixture.requests).toEqual([]);
  });
});
