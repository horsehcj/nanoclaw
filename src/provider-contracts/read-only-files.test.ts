import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { realizeProviderSpawnSurfaces } from './realize.js';
import { assertProviderHostContractShape, type ProviderHostContract } from './registry.js';
import type { VolumeMount } from '../providers/provider-container-registry.js';

let root: string;
let source: string;
const target = '/provider-state/vendor/auth.json';

function contract(): ProviderHostContract {
  return {
    seamVersion: 2,
    projectDocument: { fileName: 'AGENTS.md', containerPath: '/workspace/agent/AGENTS.md', mountClass: 'group-state' },
    stateVolumes: [
      {
        id: 'state',
        directory: 'state',
        containerPath: '/provider-state',
        scope: 'session',
        mode: 'rw',
        mountClass: 'allowlisted-extra',
      },
    ],
    skillBackings: [],
    skillViews: [],
    files: [],
    readOnlyFileMounts: [{ volumeId: 'state', relativePath: 'vendor/auth.json' }],
    legacyHostAdapter: 'required',
  };
}

function mount(overrides: Partial<VolumeMount> = {}): VolumeMount {
  return { hostPath: source, containerPath: target, readonly: true, ...overrides };
}

async function realize(mounts: VolumeMount[], declaration = contract()) {
  return realizeProviderSpawnSurfaces('file-provider', declaration, 'group', path.join(root, 'group'), root, [], {
    legacyOverlay: async () => ({ env: { PLACEHOLDER: 'unchanged' }, mounts }),
    composeProjectDocument: async () => {},
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-readonly-file-'));
  source = path.join(root, 'stub.json');
  fs.writeFileSync(source, '{"token":"placeholder"}');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('optional read-only provider files', () => {
  it('keeps only the declared file, creates its mountpoint and leaves the source untouched', async () => {
    const result = await realize([
      mount(),
      mount({ containerPath: '/undeclared' }),
      mount({ containerPath: '/provider-state', readonly: false }),
    ]);
    expect(result.contribution).toEqual({
      env: { PLACEHOLDER: 'unchanged' },
      mounts: [{ hostPath: fs.realpathSync(source), containerPath: target, readonly: true }],
    });
    expect(fs.readFileSync(path.join(root, 'state/vendor/auth.json'), 'utf8')).toBe('');
    expect(fs.readFileSync(source, 'utf8')).toBe('{"token":"placeholder"}');
    fs.writeFileSync(path.join(root, 'state/vendor/session.db'), 'writable neighbor');
  });

  it('creates no auth file when the provider does not select it', async () => {
    expect((await realize([])).contribution).toEqual({ env: { PLACEHOLDER: 'unchanged' } });
    expect(fs.existsSync(path.join(root, 'state/vendor/auth.json'))).toBe(false);
  });

  it('preserves an existing mountpoint across restarts without truncation', async () => {
    const existing = path.join(root, 'state/vendor/auth.json');
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, 'existing local state');
    await realize([mount()]);
    await realize([mount()]);
    expect(fs.readFileSync(existing, 'utf8')).toBe('existing local state');
  });

  it.each([
    ['writable', () => mount({ readonly: false })],
    ['directory', () => mount({ hostPath: root })],
    ['relative source', () => mount({ hostPath: 'stub.json' })],
    [
      'source symlink',
      () => {
        const link = path.join(root, 'link');
        fs.symlinkSync(source, link);
        return mount({ hostPath: link });
      },
    ],
  ])('rejects a %s source before creating the mountpoint', async (_name, contribution) => {
    await expect(realize([contribution()])).rejects.toThrow(/read-only regular host file/);
    expect(fs.existsSync(path.join(root, 'state/vendor/auth.json'))).toBe(false);
  });

  it('fails for a missing source and duplicate contributions', async () => {
    await expect(realize([mount({ hostPath: path.join(root, 'missing') })])).rejects.toThrow(/ENOENT/);
    await expect(realize([mount(), mount()])).rejects.toThrow(/Duplicate provider file mount/);
  });

  it('refuses an agent-planted state-root symlink before creating anything outside the session', async () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, 'state'));
    await expect(realize([mount()])).rejects.toThrow(/root must be a directory, not a symlink/);
    expect(fs.readdirSync(outside)).toEqual([]);

    const legacy = contract();
    legacy.seamVersion = 1;
    delete legacy.readOnlyFileMounts;
    await expect(realize([mount()], legacy)).resolves.toMatchObject({
      contribution: { env: { PLACEHOLDER: 'unchanged' } },
    });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it.each(['vendor', 'vendor/auth.json'])('refuses an agent-planted symlink at %s', async (relative) => {
    const outside = path.join(root, 'outside');
    const link = path.join(root, 'state', relative);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'auth.json'), 'untouched');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(relative === 'vendor' ? outside : path.join(outside, 'auth.json'), link);
    await expect(realize([mount()])).rejects.toThrow(/not a symlink/);
    expect(fs.readFileSync(path.join(outside, 'auth.json'), 'utf8')).toBe('untouched');
  });

  it('retains version 1 behavior and rejects new files without a version 2 declaration', async () => {
    const old = contract();
    old.seamVersion = 1;
    expect(() => assertProviderHostContractShape('old', old)).toThrow(/requires host seam 2/);
    delete old.readOnlyFileMounts;
    expect(() => assertProviderHostContractShape('old', old)).not.toThrow();
    expect((await realize([mount()], old)).contribution).toEqual({ env: { PLACEHOLDER: 'unchanged' } });
  });

  it.each([
    [
      'unknown volume',
      (c: ProviderHostContract) => {
        c.readOnlyFileMounts = [{ volumeId: 'missing', relativePath: 'auth.json' }];
      },
    ],
    [
      'parent traversal',
      (c: ProviderHostContract) => {
        c.readOnlyFileMounts = [{ volumeId: 'state', relativePath: '../auth.json' }];
      },
    ],
    [
      'absolute target',
      (c: ProviderHostContract) => {
        c.readOnlyFileMounts = [{ volumeId: 'state', relativePath: '/auth.json' }];
      },
    ],
    [
      'volume root',
      (c: ProviderHostContract) => {
        c.readOnlyFileMounts = [{ volumeId: 'state', relativePath: '' }];
      },
    ],
    [
      'duplicate target',
      (c: ProviderHostContract) => {
        c.readOnlyFileMounts = [...c.readOnlyFileMounts!, ...c.readOnlyFileMounts!];
      },
    ],
    [
      'read-only volume',
      (c: ProviderHostContract) => {
        c.stateVolumes = [{ ...c.stateVolumes[0], mode: 'ro' }];
      },
    ],
    [
      'prepared file',
      (c: ProviderHostContract) => {
        c.files = [
          {
            id: 'auth',
            volumeId: 'state',
            relativePath: 'vendor/auth.json',
            prepare: { operation: 'append-open-close', when: 'every-spawn' },
          },
        ];
      },
    ],
    [
      'project document',
      (c: ProviderHostContract) => {
        c.projectDocument = { ...c.projectDocument, containerPath: target };
      },
    ],
    [
      'nested state volume',
      (c: ProviderHostContract) => {
        c.stateVolumes = [
          ...c.stateVolumes,
          { ...c.stateVolumes[0], id: 'nested', directory: 'nested', containerPath: '/provider-state/vendor' },
        ];
      },
    ],
  ])('rejects %s at registration', (_name, mutate) => {
    const candidate = contract();
    mutate(candidate);
    expect(() => assertProviderHostContractShape('file-provider', candidate)).toThrow();
  });
});
