import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ui = vi.hoisted(() => ({ confirm: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock('@clack/prompts', () => ({
  confirm: ui.confirm,
  isCancel: (value: unknown) => typeof value === 'symbol',
  log: { warn: ui.warn, info: ui.info },
}));

import {
  getHostMaintenanceProvider,
  loadHostHarness,
  offerHostMaintenance,
  verifyHostHarnessDeclarations,
} from './host-maintenance.js';
import { parseProviderDescriptor } from '../providers/skill-descriptor.js';

const roots: string[] = [];
function fixture(moduleSource = ''): { root: string; skill: string; module: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-maintenance-test-'));
  roots.push(root);
  const skill = path.join(root, '.claude/skills/add-example');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(
    path.join(skill, 'SKILL.md'),
    [
      '---',
      'name: add-example',
      'description: fixture',
      'metadata:',
      '  nanoclaw-provider: example',
      '  nanoclaw-provider-label: Example',
      '  nanoclaw-provider-hint: fixture',
      "  nanoclaw-provider-offered: 'true'",
      '  nanoclaw-provider-image: local-required',
      '  nanoclaw-provider-host-harness-module: host.mjs',
      '---',
    ].join('\n'),
  );
  const module = path.join(skill, 'host.mjs');
  fs.writeFileSync(
    module,
    moduleSource ||
      `
    import fs from 'node:fs';
    import path from 'node:path';
    export const hostHarness = {
      seamVersion: 1, label: 'Example',
      async prepare() { return 'available'; },
      async configure() { return 'exited'; },
      async launch(root, file) {
        fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify({
          root, file, context: fs.readFileSync(file, 'utf8'),
          mode: fs.statSync(file).mode & 0o777,
          directoryMode: fs.statSync(path.dirname(file)).mode & 0o777,
        }));
        return 'exited';
      },
    };
  `,
  );
  return { root, skill, module };
}

beforeEach(() => {
  vi.stubEnv('NANOCLAW_HOST_PROVIDER', '');
  vi.stubEnv('NANOCLAW_AGENT_PROVIDER', '');
  vi.stubEnv('NANOCLAW_PICKED_PROVIDER', '');
  vi.stubEnv('NANOCLAW_SKIP_CLAUDE_ASSIST', '');
  vi.stubEnv('NANOCLAW_SKIP_HOST_ASSIST', '');
  vi.clearAllMocks();
  ui.confirm.mockResolvedValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('host maintenance selection and lifecycle', () => {
  it('loads the actual bundled OpenCode capability with no installed runtime payload', async () => {
    const { root } = fixture();
    const skill = '.claude/skills/add-opencode';
    const target = path.join(root, skill);
    fs.mkdirSync(path.join(target, 'payload/scripts'), { recursive: true });
    for (const file of ['SKILL.md', 'payload/scripts/opencode-host.ts']) {
      fs.copyFileSync(path.join(process.cwd(), skill, file), path.join(target, file));
    }
    fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(root, 'node_modules'));
    const harness = await loadHostHarness('opencode', root);
    expect(harness).toMatchObject({ seamVersion: 1, label: 'OpenCode' });
    expect(fs.existsSync(path.join(root, 'setup'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
    expect(ui.confirm).not.toHaveBeenCalled();
  });
  it('honors the preselected runtime before its setup payload exists', () => {
    const { root } = fixture();
    vi.stubEnv('NANOCLAW_AGENT_PROVIDER', 'OpenCode');
    expect(getHostMaintenanceProvider(root)).toBe('opencode');
  });

  it('keeps a saved host selection across reruns and different group/runtime picks', () => {
    const { root } = fixture();
    fs.writeFileSync(path.join(root, '.env'), 'HOST_HARNESS_PROVIDER=example\nDEFAULT_AGENT_PROVIDER=claude\n');
    vi.stubEnv('NANOCLAW_PICKED_PROVIDER', 'codex');
    expect(getHostMaintenanceProvider(root)).toBe('example');
    vi.stubEnv('NANOCLAW_HOST_PROVIDER', 'none');
    expect(getHostMaintenanceProvider(root)).toBe('none');
  });

  it('uses a single module before and after runtime payload installation', async () => {
    const { root } = fixture();
    const first = await loadHostHarness('example', root);
    fs.mkdirSync(path.join(root, 'setup/providers'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'setup/providers/example.ts'),
      'throw new Error("must not import runtime setup");',
    );
    expect(await loadHostHarness('example', root)).toBe(first);
    expect(await verifyHostHarnessDeclarations(root)).toEqual(['example']);
  });

  it('passes private file context, correct cwd, and cleans it after a handoff', async () => {
    const { root } = fixture();
    vi.stubEnv('NANOCLAW_HOST_PROVIDER', 'example');
    const context = 'Docker is unavailable. Read logs/setup.log; do not assume a repair succeeded.';
    expect(await offerHostMaintenance(context, root)).toBe(true);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'receipt.json'), 'utf8'));
    expect(receipt).toMatchObject({ root, context, mode: 0o600, directoryMode: 0o700 });
    expect(fs.existsSync(receipt.file)).toBe(false);
    expect(ui.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Want to debug this with Example?' }));
  });

  it('honors decline and cancel without launching or offering another assistant', async () => {
    const { root } = fixture();
    vi.stubEnv('NANOCLAW_HOST_PROVIDER', 'example');
    for (const answer of [false, Symbol('cancel')]) {
      ui.confirm.mockResolvedValueOnce(answer);
      expect(await offerHostMaintenance('failure', root)).toBe(false);
    }
    expect(fs.existsSync(path.join(root, 'receipt.json'))).toBe(false);
  });

  it('user-requested help bypasses only the second consent prompt', async () => {
    const { root } = fixture();
    vi.stubEnv('NANOCLAW_HOST_PROVIDER', 'example');
    expect(await offerHostMaintenance('help', root, true)).toBe(true);
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  it('reports a failed CLI without claiming a successful handoff', async () => {
    const { root } = fixture(
      "export const hostHarness = {seamVersion: 1, label: 'Example', async prepare(){return 'available'}, async configure(){return 'failed'}, async launch(){return 'failed'}};",
    );
    vi.stubEnv('NANOCLAW_HOST_PROVIDER', 'example');
    expect(await offerHostMaintenance('original error', root, true)).toBe(false);
    expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining('original failure'));
  });

  it('retains the failure path when a module is missing or malformed', async () => {
    const { root, module } = fixture('export const hostHarness = {};');
    vi.stubEnv('NANOCLAW_HOST_PROVIDER', 'example');
    expect(await offerHostMaintenance('failure', root)).toBe(false);
    expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
    fs.unlinkSync(module);
    expect(await offerHostMaintenance('failure', root)).toBe(false);
  });

  it('rejects a module symlink escaping the skill', async () => {
    const { root, module } = fixture();
    const outside = path.join(root, 'outside.mjs');
    fs.renameSync(module, outside);
    fs.symlinkSync(outside, module);
    await expect(loadHostHarness('example', root)).rejects.toThrow('inside its checkout skill');
  });

  it('rejects traversal and absolute descriptor paths', () => {
    const { skill } = fixture();
    const source = fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8');
    for (const target of ['../outside.mjs', '/tmp/outside.mjs', 'file:///tmp/outside.mjs']) {
      expect(() => parseProviderDescriptor(source.replace('host.mjs', target), 'add-example')).toThrow('module path');
    }
  });

  it('does not offer assistance when disabled', async () => {
    const { root } = fixture();
    vi.stubEnv('NANOCLAW_HOST_PROVIDER', 'none');
    expect(await offerHostMaintenance('failure', root)).toBe(false);
    expect(ui.confirm).not.toHaveBeenCalled();
  });
});
