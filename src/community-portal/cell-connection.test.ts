import { afterEach, expect, it, vi } from 'vitest';
import { CellConnection, type CellSocket } from './cell-connection.js';

type Listener = (event: { data: unknown }) => void;

/** A WHATWG-shaped socket the test drives by hand. */
class FakeSocket implements CellSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Listener[]>();
  constructor(
    readonly url: URL,
    readonly protocols: string[],
  ) {
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  message(data: unknown): void {
    this.emit('message', { data });
  }
  lost(): void {
    this.readyState = 3;
    this.emit('close');
  }
  private emit(type: string, event: { data: unknown } = { data: undefined }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const ORIGIN = 'https://portal.example.test';
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const connections: CellConnection[] = [];
function connect(overrides: Partial<ConstructorParameters<typeof CellConnection>[0]> = {}) {
  const log = vi.fn();
  const onChange = vi.fn();
  const getTicket = vi.fn(async () => ({ ticket: 'tkt.1', socketUrl: `wss://portal.example.test/cell/link` }));
  const connection = new CellConnection({ origin: ORIGIN, getTicket, onChange, log, Socket: FakeSocket, ...overrides });
  connections.push(connection);
  return { connection, log, onChange, getTicket };
}

afterEach(() => {
  for (const connection of connections.splice(0)) connection.stop();
  FakeSocket.instances = [];
  vi.useRealTimers();
});

it('connects with the cell subprotocols and ticket, reconciling on open and on cell pushes', async () => {
  const { connection, onChange } = connect();
  connection.start();
  await settle();
  expect(FakeSocket.instances).toHaveLength(1);
  const socket = FakeSocket.instances[0];
  expect(socket.url.href).toBe('wss://portal.example.test/cell/link');
  expect(socket.protocols).toEqual(['nc-cell', 'ticket.tkt.1']);
  expect(connection.connected).toBe(false);
  socket.open();
  expect(connection.connected).toBe(true);
  expect(onChange).toHaveBeenCalledTimes(1);
  socket.message(JSON.stringify({ type: 'perks.changed' }));
  socket.message(JSON.stringify({ type: 'snapshot' }));
  expect(onChange).toHaveBeenCalledTimes(3);
  socket.message('not json');
  socket.message(JSON.stringify({ type: 'unrelated' }));
  socket.message(Buffer.from('binary'));
  expect(onChange).toHaveBeenCalledTimes(3);
  connection.stop();
  expect(socket.closed).toBe(true);
  expect(connection.connected).toBe(false);
});

it('refuses a socket address outside the portal origin or off the cell path', async () => {
  for (const socketUrl of [
    'wss://elsewhere.example.test/cell/link',
    'wss://portal.example.test/other',
    'wss://portal.example.test/cell/link?x=1',
  ]) {
    const { connection, log } = connect({ getTicket: async () => ({ ticket: 't', socketUrl }) });
    connection.start();
    await settle();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(log).toHaveBeenCalledWith({ event: 'connection_retry', code: 'invalid_cell_url' });
    connection.stop();
  }
});

it('retries with backoff when a ticket cannot be obtained', async () => {
  vi.useFakeTimers();
  const getTicket = vi.fn(async () => {
    throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
  });
  const { connection, log } = connect({ getTicket, retryMs: 100, maxRetryMs: 1000 });
  connection.start();
  await settle();
  expect(log).toHaveBeenCalledWith({ event: 'connection_retry', code: 'ECONNREFUSED' });
  expect(getTicket).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(130);
  expect(getTicket).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(260);
  expect(getTicket).toHaveBeenCalledTimes(3);
  connection.stop();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(getTicket).toHaveBeenCalledTimes(3);
});

it('pings on the heartbeat, drops a silent socket, and reconnects with a fresh ticket', async () => {
  vi.useFakeTimers();
  const { connection, getTicket, log } = connect({
    heartbeatMs: 1_000,
    timeoutMs: 3_000,
    retryMs: 100,
    maxRetryMs: 1_000,
  });
  connection.start();
  await settle();
  const first = FakeSocket.instances[0];
  first.open();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(first.sent).toEqual(['ping']);
  first.message(JSON.stringify({ type: 'pong' }));
  await vi.advanceTimersByTimeAsync(2_500);
  expect(first.sent).toEqual(['ping', 'ping', 'ping']);
  expect(first.closed).toBe(false);
  // No pong for longer than the timeout: the socket is dropped and replaced.
  await vi.advanceTimersByTimeAsync(2_000);
  expect(first.closed).toBe(true);
  expect(connection.connected).toBe(false);
  expect(log).toHaveBeenCalledWith({ event: 'disconnected' });
  await vi.advanceTimersByTimeAsync(130);
  expect(getTicket).toHaveBeenCalledTimes(2);
  expect(FakeSocket.instances).toHaveLength(2);
  // A late close from the dropped socket changes nothing.
  first.lost();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(FakeSocket.instances).toHaveLength(2);
});

it('gives up on a handshake that never completes and reconnects', async () => {
  vi.useFakeTimers();
  const { connection } = connect({ handshakeMs: 500, retryMs: 100, maxRetryMs: 1_000 });
  connection.start();
  await settle();
  const first = FakeSocket.instances[0];
  await vi.advanceTimersByTimeAsync(500);
  expect(first.closed).toBe(true);
  await vi.advanceTimersByTimeAsync(130);
  expect(FakeSocket.instances).toHaveLength(2);
  FakeSocket.instances[1].open();
  expect(connection.connected).toBe(true);
});

it('reconnects after the cell closes the connection', async () => {
  vi.useFakeTimers();
  const { connection, log } = connect({ retryMs: 100, maxRetryMs: 1_000 });
  connection.start();
  await settle();
  const first = FakeSocket.instances[0];
  first.open();
  first.lost();
  expect(connection.connected).toBe(false);
  expect(log).toHaveBeenCalledWith({ event: 'disconnected' });
  await vi.advanceTimersByTimeAsync(130);
  expect(FakeSocket.instances).toHaveLength(2);
});
