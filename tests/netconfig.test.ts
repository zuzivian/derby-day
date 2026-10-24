import { describe, expect, test } from 'bun:test';
import { inviteCode, inviteLink, relayConfig } from '../src/net/config.ts';

describe('relay config and invite links', () => {
  test('no relay configured: Online stays hidden', () => {
    expect(relayConfig('', '')).toBeNull();
    expect(relayConfig('?relay=https://not-a-socket.example', '')).toBeNull();
    expect(relayConfig('?relay=javascript:alert(1)', '')).toBeNull();
  });

  test('build-time URL, overridden by ?relay=', () => {
    expect(relayConfig('', 'wss://relay.derby.natwong.dev/ws')).toEqual({ url: 'wss://relay.derby.natwong.dev/ws', fromQuery: false });
    expect(relayConfig('?relay=ws://127.0.0.1:9000', 'wss://relay.derby.natwong.dev/ws')).toEqual({ url: 'ws://127.0.0.1:9000/', fromQuery: true });
  });

  test('?join= codes are cleaned', () => {
    expect(inviteCode('?join=ab-c2d')).toBe('ABC2D');
    expect(inviteCode('?join=x')).toBeNull();
    expect(inviteCode('')).toBeNull();
  });

  test('invite links use the page origin, and carry a ?relay= override along', () => {
    const prod = { origin: 'https://derby.natwong.dev', pathname: '/', href: 'https://derby.natwong.dev/?x=1' };
    expect(inviteLink('ABCDE', { url: 'wss://relay.derby.natwong.dev/ws', fromQuery: false }, prod)).toBe('https://derby.natwong.dev/?join=ABCDE');
    const file = { origin: 'null', pathname: '/repo/dist/index.html', href: 'file:///repo/dist/index.html?relay=ws%3A%2F%2F127.0.0.1%3A9000%2F' };
    expect(inviteLink('ABCDE', { url: 'ws://127.0.0.1:9000/', fromQuery: true }, file)).toBe('file:///repo/dist/index.html?join=ABCDE&relay=ws%3A%2F%2F127.0.0.1%3A9000%2F');
  });
});
