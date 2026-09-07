import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  order: [] as string[],
  image: 'local',
  confirm: true as boolean | symbol,
  installed: true,
  build: { ok: true } as { ok: boolean; message?: string },
  blockers: [] as string[],
  auth: vi.fn(async () => {}),
  check: vi.fn(async () => {}),
}));
vi.mock('./providers/index.js', () => ({}));
vi.mock('./providers/registry.js', () => {
  const entry = () => ({
    value: 'opencode',
    runAuth: async () => {
      fixture.order.push('auth');
      await fixture.auth();
    },
    runInstallCheck: fixture.check,
  });
  return {
    getSetupProvider: () => (fixture.installed ? entry() : undefined),
    listSetupProviders: () => (fixture.installed ? [entry()] : []),
  };
});
vi.mock('./providers/opencode.js', () => {
  fixture.installed = true;
  fixture.order.push('load-adapter');
  return {};
});
vi.mock('./providers/skill-descriptor.js', () => ({
  getInstallableProviderDescriptor: () => ({ skillDir: '.claude/skills/add-opencode' }),
  providerImagePolicy: () => 'local-required',
}));
vi.mock('./providers/install.js', () => ({
  applyProviderSkill: async () => {
    fixture.order.push('install');
    return { changed: true, blockers: fixture.blockers };
  },
}));
vi.mock('./lib/container-build.js', () => ({
  buildContainerImage: () => {
    fixture.order.push('build');
    return fixture.build;
  },
}));
vi.mock('./lib/registry-state.js', () => ({
  HARDENED_IMAGE_ENV_KEY: 'NANOCLAW_HARDENED_IMAGE',
  readImageSource: () => fixture.image,
  writeImageSource: () => {
    fixture.order.push('local-image');
    fixture.image = 'local';
  },
}));
vi.mock('@clack/prompts', () => ({
  confirm: async () => fixture.confirm,
  isCancel: (value: unknown) => typeof value === 'symbol',
}));
import { run } from './provider-auth.js';

beforeEach(() => {
  Object.assign(fixture, {
    order: [],
    image: 'local',
    confirm: true,
    installed: true,
    build: { ok: true },
    blockers: [],
  });
  fixture.auth.mockClear();
  fixture.check.mockClear();
  vi.stubEnv('NANOCLAW_HARDENED_IMAGE', undefined);
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('setup stopped');
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('standalone provider setup flow', () => {
  it('loads the setup adapter after a fresh installation and successful image build', async () => {
    fixture.installed = false;
    await run(['opencode']);
    expect(fixture.order).toEqual(['install', 'build', 'load-adapter', 'auth']);
    expect(fixture.check).toHaveBeenCalledTimes(1);
  });
  it('resolves a local image before payload changes, then builds before auth', async () => {
    fixture.image = 'hardened';
    await run(['opencode']);
    expect(fixture.order).toEqual(['local-image', 'install', 'build', 'auth']);
    expect(fixture.check).toHaveBeenCalledTimes(1);
  });
  it('leaves the payload untouched when the image decision is declined or cancelled', async () => {
    fixture.image = 'hardened';
    for (const answer of [false, Symbol('cancel')]) {
      fixture.confirm = answer;
      await expect(run(['opencode'])).rejects.toThrow('cancelled');
      expect(fixture.order).toEqual([]);
    }
  });
  it('rejects an exported image override before payload changes', async () => {
    fixture.image = 'hardened';
    vi.stubEnv('NANOCLAW_HARDENED_IMAGE', 'true');
    await expect(run(['opencode'])).rejects.toThrow('Unset exported');
    expect(fixture.order).toEqual([]);
  });
  it('does not authenticate when installation or image building fails', async () => {
    fixture.blockers = ['incompatible core'];
    await expect(run(['opencode'])).rejects.toThrow('setup stopped');
    expect(fixture.order).toEqual(['install']);
    fixture.blockers = [];
    fixture.order = [];
    fixture.build = { ok: false, message: 'fixture build failed' };
    await expect(run(['opencode'])).rejects.toThrow('setup stopped');
    expect(fixture.order).toEqual(['install', 'build']);
    expect(fixture.auth).not.toHaveBeenCalled();
  });
});
