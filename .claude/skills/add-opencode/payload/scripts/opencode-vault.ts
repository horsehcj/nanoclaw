import { readEnvFile } from '../src/env.js';

export interface KeyInjection {
  headerName: string;
  valueFormat: string;
}

export interface OpenCodeSecret {
  name: string;
  type: 'openai' | 'generic';
  hostPattern: string;
  injectionConfig?: KeyInjection;
  authMode?: 'oauth';
}

export interface OpenCodeVault {
  find(): Promise<string | null>;
  save(value: string, existingId: string | null): Promise<string>;
  keep(existingId: string): Promise<void>;
}

const BEARER: KeyInjection = { headerName: 'Authorization', valueFormat: 'Bearer {value}' };

/** The API-key transports supported by the native backend setup flow. */
export function apiKeyInjection(provider: string): KeyInjection {
  if (provider === 'google') return { headerName: 'x-goog-api-key', valueFormat: '{value}' };
  if (provider === 'anthropic') return { headerName: 'x-api-key', valueFormat: '{value}' };
  if (['openai', 'openrouter', 'deepseek'].includes(provider)) return { ...BEARER };
  throw new Error(
    `API-key setup does not yet support the ${provider} authentication scheme. ` +
      'Use a supported backend or configure its credential in OneCLI before selecting it.',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameInjection(value: unknown, expected: KeyInjection): boolean {
  return (
    isRecord(value) &&
    value.headerName === expected.headerName &&
    value.valueFormat === expected.valueFormat &&
    Object.keys(value).every((key) => key === 'headerName' || key === 'valueFormat')
  );
}

/** Read metadata only. Never edit an inherited, ambiguous, or differently scoped credential. */
export function findOpenCodeSecret(payload: unknown, descriptor: OpenCodeSecret): string | null {
  if (!Array.isArray(payload) || !payload.every(isRecord)) {
    throw new Error('OneCLI returned invalid secret metadata.');
  }
  const matches = payload.filter((row) => row.name === descriptor.name);
  if (matches.length > 1) {
    throw new Error(`Multiple ${descriptor.name} credentials exist. Resolve duplicates in OneCLI before continuing.`);
  }
  const secret = matches[0];
  if (!secret) return null;
  const injection = descriptor.injectionConfig;
  // Older OpenCode setup used bearer injection for every generic key. Only
  // that known mistake may be repaired; arbitrary rules belong to the operator.
  const knownKeyMapping =
    !injection || sameInjection(secret.injectionConfig, injection) || sameInjection(secret.injectionConfig, BEARER);
  if (
    typeof secret.id !== 'string' ||
    !secret.id.trim() ||
    secret.type !== descriptor.type ||
    secret.hostPattern !== descriptor.hostPattern ||
    secret.valueSource !== 'inline' ||
    secret.scope !== 'project' ||
    secret.pathPattern ||
    !knownKeyMapping ||
    (descriptor.authMode && (!isRecord(secret.metadata) || secret.metadata.authMode !== descriptor.authMode))
  ) {
    throw new Error(
      `The ${descriptor.name} vault entry has unexpected metadata. Check its scope and configuration in OneCLI.`,
    );
  }
  return secret.id;
}

/** Use this installation's management connection, independently of the global OneCLI CLI configuration. */
export function createOpenCodeVault(
  descriptor: OpenCodeSecret,
  url?: string,
  apiKey?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): OpenCodeVault {
  // The setup wizard may have written these after src/config was imported.
  const saved = readEnvFile(['ONECLI_URL', 'ONECLI_API_KEY']);
  url ??= process.env.ONECLI_URL || saved.ONECLI_URL;
  apiKey ??= process.env.ONECLI_API_KEY || saved.ONECLI_API_KEY;
  if (!url) throw new Error('Configure ONECLI_URL before connecting an OpenCode credential.');
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('ONECLI_URL must be an HTTP(S) gateway URL without embedded credentials, query, or fragment.');
  }
  const projectId = process.env.ONECLI_PROJECT_ID;
  const request = async (suffix: string, method: string, body?: unknown): Promise<unknown> => {
    try {
      const response = await fetchImpl(`${base.href.replace(/\/+$/, '')}/v1/secrets${suffix}`, {
        method,
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(projectId ? { 'X-Project-Id': projectId } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch {
      // API responses can include previews of secrets. Never echo them or a
      // transport error, including when a successful write's response is lost.
      throw new Error(
        'Could not confirm the OpenCode credential in OneCLI. Check gateway connectivity and management permissions, then retry.',
      );
    }
  };
  const find = async () => findOpenCodeSecret(await request('', 'GET'), descriptor);
  return {
    find,
    async keep(existingId) {
      const metadata = await request('', 'GET');
      if (findOpenCodeSecret(metadata, descriptor) !== existingId) {
        throw new Error('The OpenCode vault entry changed during setup. Check OneCLI and retry.');
      }
      const secret = (metadata as Array<Record<string, unknown>>).find((row) => row.id === existingId)!;
      if (descriptor.injectionConfig && !sameInjection(secret.injectionConfig, descriptor.injectionConfig)) {
        await request(`/${encodeURIComponent(existingId)}`, 'PATCH', { injectionConfig: descriptor.injectionConfig });
      }
    },
    async save(value, existingId) {
      if (!value.trim()) throw new Error('Cannot save an empty OpenCode credential.');
      if ((await find()) !== existingId) {
        throw new Error('The OpenCode vault entry changed during setup. Check OneCLI and retry.');
      }
      if (existingId) {
        await request(`/${encodeURIComponent(existingId)}`, 'PATCH', {
          value,
          ...(descriptor.injectionConfig ? { injectionConfig: descriptor.injectionConfig } : {}),
        });
        return existingId;
      }
      const result = await request('', 'POST', {
        name: descriptor.name,
        type: descriptor.type,
        valueSource: 'inline',
        hostPattern: descriptor.hostPattern,
        value,
        ...(descriptor.injectionConfig ? { injectionConfig: descriptor.injectionConfig } : {}),
      });
      // Return the ID alone: the create response may also contain a key preview.
      if (!isRecord(result) || typeof result.id !== 'string' || !result.id) {
        throw new Error('OneCLI did not confirm the saved credential ID. Check its entries before retrying.');
      }
      return result.id;
    },
  };
}

export const CHATGPT_SECRET: OpenCodeSecret = {
  name: 'OpenCode ChatGPT',
  type: 'openai',
  hostPattern: 'chatgpt.com',
  authMode: 'oauth',
};
