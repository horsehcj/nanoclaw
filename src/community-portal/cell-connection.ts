import { errorCode, portalError } from './errors.js';

/**
 * The host's authenticated WebSocket to its account cell. The cell pushes
 * `snapshot` and `perks.changed`; the host answers with a reconcile. Tickets
 * are short-lived, so every (re)connect asks for a fresh one.
 *
 * Built on the WebSocket client that ships with Node 22. The constructor is
 * injectable so the reconnect and heartbeat logic can be tested without a
 * server.
 */
export interface CellTicket {
  ticket: string;
  socketUrl: string;
}

export interface CellEvent {
  event: string;
  code?: string;
  [key: string]: unknown;
}
export type CellLog = (event: CellEvent) => void;

export interface CellSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}
export type CellSocketConstructor = new (url: URL, protocols: string[]) => CellSocket;

export interface CellConnectionOptions {
  origin: string;
  getTicket(signal: AbortSignal): Promise<CellTicket>;
  onChange?: () => void;
  log?: CellLog;
  heartbeatMs?: number;
  timeoutMs?: number;
  retryMs?: number;
  maxRetryMs?: number;
  handshakeMs?: number;
  Socket?: CellSocketConstructor;
}

const CONNECTING = 0;
const OPEN = 1;
const CELL_PATH = '/cell/link';
const MAX_MESSAGE_CHARS = 512_000;

export class CellConnection {
  connected = false;
  private readonly origin: string;
  private readonly getTicket: (signal: AbortSignal) => Promise<CellTicket>;
  private readonly onChange: () => void;
  private readonly log: CellLog;
  private readonly heartbeatMs: number;
  private readonly timeoutMs: number;
  private readonly retryMs: number;
  private readonly maxRetryMs: number;
  private readonly handshakeMs: number;
  private readonly Socket: CellSocketConstructor;
  private socket?: CellSocket;
  private stopped = true;
  private connecting = false;
  private attempt = 0;
  private lastPong = 0;
  private abort = new AbortController();
  private heartbeat?: NodeJS.Timeout;
  private reconnect?: NodeJS.Timeout;

  constructor({
    origin,
    getTicket,
    onChange = () => {},
    log = () => {},
    heartbeatMs = 20_000,
    timeoutMs = 60_000,
    retryMs = 1_000,
    maxRetryMs = 30_000,
    handshakeMs = 10_000,
    Socket = globalThis.WebSocket as unknown as CellSocketConstructor,
  }: CellConnectionOptions) {
    this.origin = origin;
    this.getTicket = getTicket;
    this.onChange = onChange;
    this.log = log;
    this.heartbeatMs = heartbeatMs;
    this.timeoutMs = timeoutMs;
    this.retryMs = retryMs;
    this.maxRetryMs = maxRetryMs;
    this.handshakeMs = handshakeMs;
    this.Socket = Socket;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.abort = new AbortController();
    this.heartbeat = setInterval(() => this.beat(), this.heartbeatMs);
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    clearInterval(this.heartbeat);
    clearTimeout(this.reconnect);
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    if (socket) closeQuietly(socket);
  }

  private beat(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    if (Date.now() - this.lastPong > this.timeoutMs) {
      this.drop(socket);
      return;
    }
    socket.send('ping');
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.socket) return;
    this.connecting = true;
    try {
      const { ticket, socketUrl } = await this.getTicket(this.abort.signal);
      if (this.stopped) return;
      const url = new URL(socketUrl);
      if (
        url.origin !== this.origin.replace(/^http/, 'ws') ||
        url.pathname !== CELL_PATH ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      )
        throw portalError('The cell returned an unexpected socket address.', 'invalid_cell_url');
      const socket = new this.Socket(url, ['nc-cell', `ticket.${ticket}`]);
      this.socket = socket;
      const handshake = setTimeout(() => {
        if (socket.readyState === CONNECTING) this.drop(socket);
      }, this.handshakeMs);
      socket.addEventListener('open', () => {
        clearTimeout(handshake);
        if (this.socket !== socket) return;
        this.connected = true;
        this.attempt = 0;
        this.lastPong = Date.now();
        this.log({ event: 'connected' });
        this.onChange();
      });
      socket.addEventListener('message', (event) => {
        if (this.socket !== socket || typeof event.data !== 'string' || event.data.length > MAX_MESSAGE_CHARS) return;
        let message: { type?: unknown } | null;
        try {
          message = JSON.parse(event.data) as { type?: unknown } | null;
        } catch (_error) {
          return;
        }
        if (message?.type === 'pong') this.lastPong = Date.now();
        else if (message?.type === 'snapshot' || message?.type === 'perks.changed') this.onChange();
      });
      socket.addEventListener('error', () => {});
      socket.addEventListener('close', () => {
        clearTimeout(handshake);
        this.drop(socket);
      });
    } catch (error) {
      if (!this.stopped) {
        this.log({ event: 'connection_retry', code: errorCode(error) });
        this.retry();
      }
    } finally {
      this.connecting = false;
    }
  }

  /** Forget `socket` and schedule a reconnect. A no-op for a socket already replaced. */
  private drop(socket: CellSocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    closeQuietly(socket);
    if (this.connected) this.log({ event: 'disconnected' });
    this.connected = false;
    this.retry();
  }

  private retry(): void {
    if (this.stopped) return;
    clearTimeout(this.reconnect);
    const delay = Math.min(this.maxRetryMs, this.retryMs * 2 ** Math.min(this.attempt++, 5));
    this.reconnect = setTimeout(() => void this.connect(), delay + (Math.random() * delay) / 4);
  }
}

function closeQuietly(socket: CellSocket): void {
  try {
    socket.close();
  } catch (_error) {
    // Already closing or closed.
  }
}
