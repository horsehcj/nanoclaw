import fs from 'fs';
import path from 'path';
import ts from 'typescript';

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  saved: {} as Record<string, string>,
  selected: 'opencode',
  select: vi.fn(),
  confirm: vi.fn(),
  prepare: vi.fn(),
  configure: vi.fn(),
  upsert: vi.fn(),
  offer: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@clack/prompts', () => ({
  select: state.select,
  confirm: state.confirm,
  isCancel: (v: unknown) => typeof v === 'symbol',
  log: { warn: state.warn },
}));
vi.mock('../src/env.js', () => ({ readEnvFile: () => state.saved }));
vi.mock('./set-env.js', () => ({ upsertEnvVar: state.upsert }));
vi.mock('./providers/skill-descriptor.js', () => ({
  listProviderDescriptors: () => [{ value: 'opencode', label: 'OpenCode', hostHarnessModule: 'host.ts' }],
}));
vi.mock('./lib/host-maintenance.js', () => ({
  getHostMaintenanceProvider: () => state.selected,
  loadHostHarness: async (name: string) =>
    name === 'opencode' ? { label: 'OpenCode', prepare: state.prepare, configure: state.configure } : undefined,
  offerHostMaintenance: state.offer,
}));
import { run, selectHostMaintenance } from './maintenance.js';

beforeEach(() => {
  state.saved = {};
  state.selected = 'opencode';
  vi.clearAllMocks();
  vi.stubEnv('NANOCLAW_HOST_PROVIDER', '');
  vi.stubEnv('NANOCLAW_SKIP_HOST_ASSIST', '');
  vi.stubEnv('NANOCLAW_SKIP_CLAUDE_ASSIST', '');
  state.select.mockResolvedValue('opencode');
  state.confirm.mockResolvedValue(false);
  state.prepare.mockResolvedValue('available');
  state.configure.mockResolvedValue('exited');
  state.offer.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe('host setup and maintenance entry points', () => {
  it('prepares a preset CLI even though the choice prompt is skipped', async () => {
    vi.stubEnv('NANOCLAW_HOST_PROVIDER', 'opencode');
    await selectHostMaintenance();
    expect(state.select).not.toHaveBeenCalled();
    expect(state.prepare).toHaveBeenCalledOnce();
    expect(state.upsert).not.toHaveBeenCalled();
  });
  it('checks a saved CLI on rerun without reopening native configuration', async () => {
    state.saved.HOST_HARNESS_PROVIDER = 'opencode';
    await selectHostMaintenance();
    expect(state.prepare).toHaveBeenCalledOnce();
    expect(state.select).not.toHaveBeenCalled();
    expect(state.configure).not.toHaveBeenCalled();
    expect(state.confirm).not.toHaveBeenCalled();
  });
  it('suggests an explicit Claude runtime choice over an older OpenCode runtime default', async () => {
    state.selected = 'opencode';
    state.select.mockResolvedValue('claude');
    await selectHostMaintenance('claude');
    expect(state.select).toHaveBeenCalledWith(expect.objectContaining({ initialValue: 'claude' }));
    expect(state.upsert).toHaveBeenCalledWith('HOST_HARNESS_PROVIDER', 'claude');
    expect(state.prepare).not.toHaveBeenCalled();
  });
  it('keeps user state unchanged when explicit configuration is cancelled', async () => {
    state.select.mockResolvedValue(Symbol('cancel'));
    await run(['--', '--configure']);
    expect(state.upsert).not.toHaveBeenCalled();
    expect(state.prepare).not.toHaveBeenCalled();
  });
  it('treats host setup as optional when its installer fails', async () => {
    state.prepare.mockRejectedValue(new Error('offline'));
    await expect(selectHostMaintenance()).resolves.toBeUndefined();
    expect(state.warn).toHaveBeenCalledWith(expect.stringContaining('Setup can continue'));
    expect(state.configure).not.toHaveBeenCalled();
  });
  it('passes the actual update skill request through the documented pnpm syntax', async () => {
    await run(['--', '--update']);
    expect(state.offer).toHaveBeenCalledWith(
      expect.stringContaining('.claude/skills/update-nanoclaw/SKILL.md'),
      process.cwd(),
      true,
    );
    expect(state.offer.mock.calls[0][0]).not.toContain('add-maintenance');
  });
  it('preserves the actual runtime choice when setup re-executes before authentication', async () => {
    // Exercise the real picker and its early caller without starting services.
    const filename = path.join(process.cwd(), 'setup/auto.ts');
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    const functions = source.statements.filter(ts.isFunctionDeclaration);
    const picker = functions.find((node) => node.name?.text === 'askAgentProviderChoice')!;
    const main = functions.find((node) => node.name?.text === 'main')!;
    const selection = main.body!.statements.find(
      (node) => ts.isIfStatement(node) && node.thenStatement.getText(source).includes('await askAgentProviderChoice()'),
    )!;
    const code = ts.transpileModule(
      `${picker.getText(source)}; return async function select() { let agentProvider; ${selection.getText(source)}; return agentProvider; }`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
    ).outputText;
    for (const chosen of ['opencode', 'claude']) {
      const environment = { env: {} as Record<string, string> };
      const prompt = vi.fn().mockResolvedValue(chosen);
      const select = new Function(
        'process',
        'skip',
        'listSetupProviders',
        'listInstallableProviderDescriptors',
        'readImageSource',
        'setupLog',
        'phEmit',
        'DEFAULT_AGENT_PROVIDER',
        'ensureAnswer',
        'brightSelect',
        'setPickedProvider',
        code,
      )(
        environment,
        new Set(),
        () => [{ value: 'claude' }, { value: 'opencode' }],
        () => [],
        () => 'local',
        { userInput() {} },
        () => {},
        chosen === 'claude' ? 'opencode' : 'claude',
        (answer: string) => answer,
        prompt,
        () => {},
      ) as () => Promise<string>;
      expect(await select()).toBe(chosen);
      expect(environment.env.NANOCLAW_AGENT_PROVIDER).toBe(chosen);
      expect(await select()).toBe(chosen);
      expect(prompt).toHaveBeenCalledOnce();
    }
  });
  it('loads host maintenance before the first environment step in setup main', () => {
    const filename = path.join(process.cwd(), 'setup/auto.ts');
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    const main = source.statements.find(
      (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'main',
    );
    expect(main?.body).toBeDefined();
    const statements = main!.body!.statements;
    const host = statements.findIndex(
      (node) =>
        ts.isExpressionStatement(node) &&
        ts.isAwaitExpression(node.expression) &&
        ts.isCallExpression(node.expression.expression) &&
        node.expression.expression.expression.getText(source) === 'selectHostMaintenance',
    );
    const environment = statements.findIndex(
      (node) => ts.isIfStatement(node) && node.expression.getText(source) === "!skip.has('environment')",
    );
    const runtime = statements.findIndex(
      (node) => ts.isIfStatement(node) && node.thenStatement.getText(source).includes('await askAgentProviderChoice()'),
    );
    expect(runtime).toBeGreaterThan(-1);
    expect(host).toBeGreaterThan(runtime);
    expect(host).toBeGreaterThan(-1);
    expect(environment).toBeGreaterThan(host);
    expect(
      source.statements.some(
        (node) =>
          ts.isImportDeclaration(node) &&
          node.moduleSpecifier.getText(source) === "'./maintenance.js'" &&
          node.importClause?.namedBindings?.getText(source).includes('selectHostMaintenance'),
      ),
    ).toBe(true);
  });
});
