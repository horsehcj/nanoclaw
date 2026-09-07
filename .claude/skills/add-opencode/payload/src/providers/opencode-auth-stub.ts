/** The container gets no tokens or account metadata; OneCLI owns both. */
export function buildOneCliManagedStub(): Record<string, unknown> {
  return {
    openai: { type: 'oauth', access: 'onecli-managed', refresh: 'onecli-managed', expires: Date.UTC(2100, 0, 1) },
  };
}

export function isOneCliManagedStub(contents: string): boolean {
  try {
    const parsed = JSON.parse(contents);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).join() !== 'openai')
      return false;
    const record = parsed.openai;
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    const expected = buildOneCliManagedStub().openai as Record<string, unknown>;
    return (
      Object.keys(record).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, value]) => record[key] === value)
    );
  } catch {
    return false;
  }
}
