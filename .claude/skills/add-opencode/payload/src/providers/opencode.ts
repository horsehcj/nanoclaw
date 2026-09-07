/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode's `opencode serve` process stores state under XDG_DATA_HOME, which
 * we pin to a per-session host directory mounted at /opencode-xdg. The
 * OPENCODE_* env vars tell the CLI which provider/model to use at runtime
 * (read on the host, injected into the container). NO_PROXY / no_proxy are
 * merged with host values so the in-container OpenCode client can talk to
 * 127.0.0.1 even when HTTPS_PROXY is set by OneCLI.
 */
import fs from 'fs';
import path from 'path';

import { isOneCliManagedStub } from './opencode-auth-stub.js';
import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const PASSTHROUGH_KEYS = [
  'OPENCODE_PROVIDER',
  'OPENCODE_MODEL',
  'OPENCODE_SMALL_MODEL',
  'OPENCODE_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'OPENCODE_MODEL_CONTEXT_LIMIT',
  'OPENCODE_MODEL_OUTPUT_LIMIT',
  'OPENCODE_MODEL_INPUT_MODALITIES',
  'OPENCODE_NATIVE_ATTACHMENT_MAX_COUNT',
  'OPENCODE_NATIVE_ATTACHMENT_MAX_BYTES',
] as const;
const AUTH_MODE_KEY = 'OPENCODE_AUTH_MODE';

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

registerProviderContainerConfig('opencode', (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  if (!ctx.coreOwnsProviderSurfaces) fs.mkdirSync(opencodeDir, { recursive: true });

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
  };
  // The host process does not load `.env` into process.env (readEnvFile keeps
  // file values out of child processes), and the service units set no
  // EnvironmentFile — so under launchd/systemd, ctx.hostEnv carries none of
  // these. Fall back to the `.env` file the way the claude provider does;
  // a real exported variable still wins over the file.
  const dotenv = readEnvFile([...PASSTHROUGH_KEYS, AUTH_MODE_KEY]);
  for (const key of PASSTHROUGH_KEYS) {
    const value = ctx.hostEnv[key] ?? dotenv[key];
    if (value) env[key] = value;
  }

  const mounts = ctx.coreOwnsProviderSurfaces
    ? []
    : [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }];
  const authMode: string | undefined = ctx.hostEnv[AUTH_MODE_KEY] ?? dotenv[AUTH_MODE_KEY];
  if (authMode === 'chatgpt') {
    const stubPath = path.join(DATA_DIR, 'opencode', 'openai-auth-stub.json');
    if (!fs.existsSync(stubPath)) {
      throw new Error('OpenCode ChatGPT auth is selected, but its OneCLI credential stub is missing; re-run setup');
    }
    if (!isOneCliManagedStub(fs.readFileSync(stubPath, 'utf8'))) {
      throw new Error('OpenCode ChatGPT credential stub is invalid; run scripts/opencode-auth.ts');
    }
    // Docker must see the nested file target inside the outer XDG bind before
    // it composes the read-only stub mount (especially under macOS virtiofs).
    const authTarget = path.join(opencodeDir, 'opencode', 'auth.json');
    if (!ctx.coreOwnsProviderSurfaces) {
      fs.mkdirSync(path.dirname(authTarget), { recursive: true });
      fs.closeSync(fs.openSync(authTarget, 'a'));
    }
    // OpenCode reads $XDG_DATA_HOME/opencode/auth.json. This RO file contains
    // only fixed onecli-managed sentinels;
    // OneCLI replaces the bearer at the gateway boundary.
    mounts.push({ hostPath: stubPath, containerPath: '/opencode-xdg/opencode/auth.json', readonly: true });
  }

  return {
    mounts,
    env,
  };
});
