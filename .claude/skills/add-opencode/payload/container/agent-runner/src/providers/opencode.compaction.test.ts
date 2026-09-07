import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDeliverySentences } from '../compact-instructions.js';
import { prepareOpenCodeMemory } from './opencode-memory.js';
import memoryPlugin from './opencode-memory-plugin.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('routing through native compaction', () => {
  it.each([null, 'task_fixture'])(
    'keeps core delivery wording during native continuation (task=%s)',
    async (taskId) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-routing-'));
      directories.push(directory);
      const reminder = buildDeliverySentences(['family', 'ops'], taskId).join(' ');
      prepareOpenCodeMemory(
        'ses_routing',
        { command: 'true', legacyCommands: [], sources: ['startup', 'compact'] },
        'CORE',
        reminder,
        true,
        directory,
      );
      const hooks = await memoryPlugin({}, { directory });
      await hooks['experimental.session.compacting']({ sessionID: 'ses_routing' }, { context: [] });
      const output = { system: [] as string[] };
      await hooks['experimental.chat.system.transform']({ sessionID: 'ses_routing' }, output);
      expect(output.system.join('\n')).toContain(reminder);
      expect(output.system.join('\n')).toContain(taskId ? 'send_message' : '<message to="name">');
    },
  );
});
