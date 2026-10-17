import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkAddress, checkHostSyntax, checkPort } from '@datasentinel/connectors';

describe('host syntax', () => {
  it('accepts host names and IP literals', () => {
    for (const host of ['db.example.com', 'my-db', '10.0.0.5', '2001:db8::1', 'DB.Example.COM']) {
      assert.equal(checkHostSyntax(host), undefined, host);
    }
  });

  it('refuses URLs, ports, credentials, spaces, and junk', () => {
    for (const host of [
      'postgres://db.example.com',
      'db.example.com:5432',
      'user@db.example.com',
      'db example.com',
      '',
      '-db.example.com',
      'db..example.com',
      'a'.repeat(254),
      '[2001:db8::1]',
    ]) {
      assert.notEqual(checkHostSyntax(host), undefined, host);
    }
  });
});

describe('destination policy', () => {
  const blockedAlways = [
    '169.254.169.254',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    'fe80::1',
    '::',
  ];
  const privateOnly = [
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.10',
    '127.0.0.1',
    '::1',
    'fd00::1',
    '100.64.0.1',
  ];
  const publicOk = ['8.8.8.8', '2001:4860:4860::8888', '34.1.2.3'];

  it('always refuses link-local (cloud metadata), unspecified, and multicast', () => {
    for (const ip of blockedAlways) {
      assert.notEqual(checkAddress(ip, 'allow-private'), undefined, ip);
      assert.notEqual(checkAddress(ip, 'public-only'), undefined, ip);
    }
  });

  it('refuses private and loopback addresses unless private networks are allowed', () => {
    for (const ip of privateOnly) {
      assert.notEqual(checkAddress(ip, 'public-only'), undefined, ip);
      assert.equal(checkAddress(ip, 'allow-private'), undefined, ip);
    }
  });

  it('refuses IPv4 addresses hidden in IPv6 forms', () => {
    assert.notEqual(checkAddress('::ffff:169.254.169.254', 'allow-private'), undefined);
    assert.notEqual(checkAddress('::ffff:10.0.0.1', 'public-only'), undefined);
  });

  it('accepts public addresses', () => {
    for (const ip of publicOk) assert.equal(checkAddress(ip, 'public-only'), undefined, ip);
  });

  it('only allows unprivileged ports', () => {
    assert.equal(checkPort(5432), undefined);
    assert.equal(checkPort(65535), undefined);
    assert.notEqual(checkPort(22), undefined);
    assert.notEqual(checkPort(0), undefined);
  });
});
