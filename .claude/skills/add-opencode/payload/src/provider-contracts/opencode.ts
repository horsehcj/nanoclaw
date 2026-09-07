import { CLAUDE_COMPATIBLE_HOST_SURFACES } from './claude.js';
import { registerProviderHostContract } from './registry.js';

// Version 2 is required: version 1 core discarded the callback's nested auth bind.
registerProviderHostContract('opencode', {
  seamVersion: 2,
  legacyHostAdapter: 'required',
  ...CLAUDE_COMPATIBLE_HOST_SURFACES,
  stateVolumes: [
    ...CLAUDE_COMPATIBLE_HOST_SURFACES.stateVolumes,
    {
      id: 'opencode-xdg',
      directory: 'opencode-xdg',
      containerPath: '/opencode-xdg',
      scope: 'session',
      mode: 'rw',
      mountClass: 'allowlisted-extra',
    },
  ],
  readOnlyFileMounts: [{ volumeId: 'opencode-xdg', relativePath: 'opencode/auth.json' }],
  commands: { nativeAdmin: [], nativeFiltered: [] },
});
