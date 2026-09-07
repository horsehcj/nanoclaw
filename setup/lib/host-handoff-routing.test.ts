import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ offer: vi.fn(async () => true), ready: vi.fn() }));
vi.mock('./host-maintenance.js', () => ({
  offerHostMaintenance: native.offer,
  getHostMaintenanceProvider: () => 'opencode',
}));
vi.mock('./runner.js', () => ({ ensureAnswer: (value: unknown) => value }));
vi.mock('./claude-assist.js', async (original) => ({
  ...(await original<object>()),
  ensureClaudeReady: native.ready,
  isClaudeReady: native.ready,
}));

import { offerClaudeHandoff, offerClaudeOnFailure } from './claude-handoff.js';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
describe('shared setup handoff dispatch', () => {
  it('routes an early setup failure to the selected host harness before consulting Claude', async () => {
    vi.stubEnv('NANOCLAW_SKIP_CLAUDE_ASSIST', '');
    expect(await offerClaudeOnFailure({ stepName: 'onecli', msg: 'gateway missing' }, '/tmp/checkout')).toBe(true);
    expect(native.offer).toHaveBeenCalledWith(expect.stringContaining('gateway missing'), '/tmp/checkout');
    expect(native.ready).not.toHaveBeenCalled();
  });
  it('routes question-mark help through the same capability', async () => {
    expect(await offerClaudeHandoff({ channel: 'telegram', step: 'token', stepDescription: 'create bot' })).toBe(true);
    expect(native.offer).toHaveBeenCalledWith(expect.stringContaining('create bot'), process.cwd(), true);
    expect(native.ready).not.toHaveBeenCalled();
  });
});
