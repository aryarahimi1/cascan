/**
 * Resolve the exact transport/port a server record was verified on.
 * Discovery records carry `transport` + `port`; curated records fall back
 * to the strongest advertised transport.
 */

const TRANSPORTS = ['ssl', 'tcp', 'wss', 'ws'];

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

export function serverName(server) {
  if (!server) return null;
  const { port } = serverDialTarget(server);
  return `${server.host}:${port}`;
}
