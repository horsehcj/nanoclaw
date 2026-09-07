import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  writes: [] as Array<[string, string | null]>,
  failVault: false,
  cancelPassword: false,
  keyFile: '',
  observedKey: '',
  writesAtVault: -1,
}));
vi.mock('../setup/lib/bright-select.js', () => ({
  brightSelect: async ({ message }: { message: string }) =>
    message.includes('backend') ? 'openrouter' : 'openrouter/fixture',
}));
vi.mock('@clack/prompts', () => ({
  isCancel: (value: unknown) => typeof value === 'symbol',
  cancel: () => {
    throw new Error('cancelled');
  },
  text: async () => 'openrouter/fixture',
  password: async () => (fixture.cancelPassword ? Symbol('cancel') : 'fixture-key'),
  log: { success: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../setup/logs.js', () => ({ userInput: vi.fn(), step: vi.fn() }));
vi.mock('../setup/set-env.js', () => ({
  upsertEnvVar: (key: string, value: string) => fixture.writes.push([key, value]),
  removeEnvVar: (key: string) => fixture.writes.push([key, null]),
}));
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  execFileSync: (_command: string, args: string[]) => {
    if (args.includes('models')) throw new Error('catalog unavailable');
    fixture.writesAtVault = fixture.writes.length;
    expect(args).not.toContain('fixture-key');
    expect(args).not.toContain('--value');
    fixture.keyFile = args[args.indexOf('--file') + 1];
    fixture.observedKey = fs.readFileSync(fixture.keyFile, 'utf8');
    expect(fs.statSync(fixture.keyFile).mode & 0o777).toBe(0o600);
    if (fixture.failVault) throw new Error('vault unavailable');
    return '';
  },
}));
import { runOpenCodeAuthStep } from './opencode-auth.js';

beforeEach(() =>
  Object.assign(fixture, {
    writes: [],
    failVault: false,
    cancelPassword: false,
    keyFile: '',
    observedKey: '',
    writesAtVault: -1,
  }),
);
describe('OpenCode auth configuration commit', () => {
  it('vaults first, removes its temporary key, and writes only provider-owned settings', async () => {
    await runOpenCodeAuthStep();
    expect(fixture.writesAtVault).toBe(0);
    expect(fixture.observedKey).toBe('fixture-key');
    expect(fs.existsSync(fixture.keyFile)).toBe(false);
    expect(fixture.writes).toContainEqual(['OPENCODE_BASE_URL', 'native']);
    expect(fixture.writes.every(([key]) => key.startsWith('OPENCODE_'))).toBe(true);
  });
  it('preserves defaults and removes the temporary key when vaulting fails', async () => {
    fixture.failVault = true;
    await expect(runOpenCodeAuthStep()).rejects.toThrow('Could not save the API key');
    expect(fixture.writes).toEqual([]);
    expect(fs.existsSync(fixture.keyFile)).toBe(false);
  });
  it('preserves defaults when the password prompt is cancelled', async () => {
    fixture.cancelPassword = true;
    await expect(runOpenCodeAuthStep()).rejects.toThrow('cancelled');
    expect(fixture.writes).toEqual([]);
    expect(fixture.keyFile).toBe('');
  });
});
