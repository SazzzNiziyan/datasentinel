/**
 * Where a source may point (docs/05, D-48). Checked when a source is saved
 * (syntax, IP literals) and again after DNS resolution right before every
 * connection, so a name that later resolves somewhere forbidden (DNS
 * rebinding) is still refused. Messages are fixed text: they never echo
 * the host back.
 */
import { BlockList, isIP } from 'node:net';

/** `public-only` for production; `allow-private` lets a local or VPC
 * database be used (development, self-hosted). */
export type NetworkPolicy = 'public-only' | 'allow-private';

const always = new BlockList();
// Link-local, including cloud metadata endpoints (169.254.169.254).
always.addSubnet('169.254.0.0', 16, 'ipv4');
always.addSubnet('fe80::', 10, 'ipv6');
// "This network", multicast, reserved, broadcast.
always.addSubnet('0.0.0.0', 8, 'ipv4');
always.addSubnet('224.0.0.0', 4, 'ipv4');
always.addSubnet('240.0.0.0', 4, 'ipv4');
always.addAddress('::', 'ipv6');
always.addSubnet('ff00::', 8, 'ipv6');

const privateNets = new BlockList();
privateNets.addSubnet('10.0.0.0', 8, 'ipv4');
privateNets.addSubnet('172.16.0.0', 12, 'ipv4');
privateNets.addSubnet('192.168.0.0', 16, 'ipv4');
privateNets.addSubnet('127.0.0.0', 8, 'ipv4');
privateNets.addSubnet('100.64.0.0', 10, 'ipv4');
privateNets.addSubnet('192.0.0.0', 24, 'ipv4');
privateNets.addSubnet('198.18.0.0', 15, 'ipv4');
privateNets.addAddress('::1', 'ipv6');
privateNets.addSubnet('fc00::', 7, 'ipv6');

/** "::ffff:10.0.0.1" is IPv4 in disguise; judge the IPv4 part. */
function normalize(ip: string): { address: string; family: 'ipv4' | 'ipv6' } {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1] !== undefined) return { address: mapped[1], family: 'ipv4' };
  return { address: ip, family: isIP(ip) === 6 ? 'ipv6' : 'ipv4' };
}

/** Why an IP address may not be used, or undefined when it may. */
export function checkAddress(ip: string, policy: NetworkPolicy): string | undefined {
  if (isIP(ip) === 0) return 'This is not an IP address.';
  const { address, family } = normalize(ip);
  if (always.check(address, family)) {
    return 'This address is reserved or link-local, so DataSentinel never connects to it.';
  }
  if (policy === 'public-only' && privateNets.check(address, family)) {
    return 'Private and local network addresses are not allowed here.';
  }
  return undefined;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;

/** Why a host is not a plain host name or IP address, or undefined. */
export function checkHostSyntax(host: string): string | undefined {
  if (isIP(host) !== 0) return undefined;
  if (host.length === 0 || host.length > 253 || !host.split('.').every((l) => LABEL.test(l))) {
    return 'Enter a host name such as db.example.com, or an IP address, without a port or scheme.';
  }
  return undefined;
}

/** Why a port may not be used, or undefined. Privileged ports (below
 * 1024) are refused: no database server needs them, other services do. */
export function checkPort(port: number): string | undefined {
  return Number.isInteger(port) && port >= 1024 && port <= 65_535
    ? undefined
    : 'Use a port from 1024 to 65535 (PostgreSQL usually listens on 5432).';
}
