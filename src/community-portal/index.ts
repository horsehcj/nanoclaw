/**
 * Client for the NanoClaw community portal (https://portal.nanoclaw.dev).
 *
 * The portal itself is a hosted service; this is the open-source side of the
 * contract: a device identity, signed requests, the sealed-credential handoff,
 * and the cell WebSocket that tells a running host when its perks change.
 * Everything here depends only on Node built-ins.
 */
export * from './cell-connection.js';
export * from './device-client.js';
export * from './device-proof.js';
export * from './errors.js';
export * from './install-envelope.js';
export * from './private-file.js';
export * from './process-lock.js';
export * from './setup-client.js';
