/** Host maintenance runs before the container, runtime payload, or vault exists. */
export const HOST_HARNESS_SEAM_VERSION = 1;

export type HostHarnessPreparation = 'available' | 'declined' | 'unavailable';
export type HostHarnessExit = 'exited' | 'failed';

export interface HostHarness {
  seamVersion: number;
  label: string;
  /** Install/detect the CLI only. Availability does not establish model access. */
  prepare(projectRoot: string): Promise<HostHarnessPreparation>;
  /** Native interactive configuration; credentials remain owned by the harness. */
  configure(projectRoot: string): Promise<HostHarnessExit>;
  /** Inherit the terminal and native permissions; return control on exit. */
  launch(projectRoot: string, contextFile?: string): Promise<HostHarnessExit>;
}

export function assertHostHarness(value: unknown): asserts value is HostHarness {
  if (!value || typeof value !== 'object') throw new Error('Host harness declaration is missing');
  const entry = value as Record<string, unknown>;
  if (entry.seamVersion !== HOST_HARNESS_SEAM_VERSION) {
    throw new Error(`Unsupported host harness seam: ${String(entry.seamVersion)}`);
  }
  if (typeof entry.label !== 'string' || !entry.label.trim()) throw new Error('Host harness label is required');
  for (const method of ['prepare', 'configure', 'launch']) {
    if (typeof entry[method] !== 'function') throw new Error(`Host harness ${method} is required`);
  }
}
