/**
 * Resolve the exact transport/port a server record was verified on.
 * Discovery records carry `transport` + `port`; curated records fall back
 * to the strongest advertised transport.
 */

const TRANSPORTS = ['ssl', 'tcp', 'wss', 'ws'];

export class InsecureTransportError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'InsecureTransportError';
    this.code = 'INSECURE_TRANSPORT';
    this.kind = 'configuration';
    this.server = opts.server;
  }
}

export function serverDialTarget(server) {
  const verifiedTransport = TRANSPORTS.includes(server?.transport) ? server.transport : null;
  if (verifiedTransport) {
    const port = server.port ?? server.ports?.[verifiedTransport];
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      return { transport: verifiedTransport, port };
    }
  }

  for (const transport of TRANSPORTS) {
    const port = server?.ports?.[transport];
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      return { transport, port };
    }
  }

  if (Number.isInteger(server?.port) && server.port > 0 && server.port < 65536) {
    return { transport: server?.tls === false ? 'tcp' : 'ssl', port: server.port };
  }
  throw new Error(`server ${server?.host ?? '<unknown>'} has no usable transport`);
}

/** Certificate-authenticated TLS is the only payment-safe Node transport. */
export function isAuthenticatedTransport(server, target = serverDialTarget(server)) {
  return (target.transport === 'ssl' || target.transport === 'wss')
    && server?.tlsStrict !== false
    && server?.rejectUnauthorized !== false;
}

/** Resolve a dial target and fail closed unless insecure use was explicit. */
export function requireAllowedTransport(server, opts = {}) {
  const target = serverDialTarget(server);
  if (!isAuthenticatedTransport(server, target) && opts.allowInsecureTransport !== true) {
    throw new InsecureTransportError(
      `server ${server?.host ?? '<unknown>'}:${target.port} does not use certificate-authenticated TLS`,
      { server: server?.host },
    );
  }
  return target;
}

export function serverName(server) {
  if (!server) return null;
  const { port } = serverDialTarget(server);
  return `${server.host}:${port}`;
}
