import { describe, expect, test } from 'bun:test';
import { inviteCode, inviteLink, relayConfig } from '../src/net/config.ts';

const file = (search: string) => ({ protocol: 'file:', hostname: '', search });
const prod = (search: string) => ({ protocol: 'https:', hostname: 'derby.natwong.dev', search });

describe('relay config and invite links', () => {
  test('no relay configured: Online stays hidden', () => {
    expect(relayConfig(file(''), '')).toBeNull();
    expect(relayConfig(file('?relay=https://not-a-socket.example'), '')).toBeNull();
    expect(relayConfig(file('?relay=javascript:alert(1)'), '')).toBeNull();
  });

  test('build-time URL, overridden by ?relay= on local pages only', () => {
    expect(relayConfig(prod(''), 'wss://relay.derby.natwong.dev/ws')).toEqual({ url: 'wss://relay.derby.natwong.dev/ws', fromQuery: false });
    expect(relayConfig(file('?relay=ws://127.0.0.1:9000'), 'wss://relay.derby.natwong.dev/ws')).toEqual({ url: 'ws://127.0.0.1:9000/', fromQuery: true });
    expect(relayConfig({ protocol: 'http:', hostname: 'localhost', search: '?relay=ws://localhost:8787/ws' }, '')).toEqual({ url: 'ws://localhost:8787/ws', fromQuery: true });
    // On the real site an invite link can't point players at another server.
    expect(relayConfig(prod('?join=ABCDEF&relay=wss://evil.example/ws'), 'wss://relay.derby.natwong.dev/ws')).toEqual({ url: 'wss://relay.derby.natwong.dev/ws', fromQuery: false });
    expect(relayConfig(prod('?relay=wss://evil.example/ws'), '')).toBeNull();
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
