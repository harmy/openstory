import { describe, expect, it } from 'vitest';
import { assertSafeImageUrl } from './safe-fetch';

describe('assertSafeImageUrl', () => {
  it('allows ordinary public https/http image URLs', () => {
    expect(
      assertSafeImageUrl('https://cdn.example.com/logo.png').hostname
    ).toBe('cdn.example.com');
    expect(assertSafeImageUrl('http://images.example.org/a.jpg').hostname).toBe(
      'images.example.org'
    );
  });

  it.each([
    ['file:///etc/passwd', 'non-http scheme'],
    ['ftp://example.com/x', 'non-http scheme'],
    ['http://localhost/x', 'localhost'],
    ['http://foo.internal/x', '.internal'],
    ['http://printer.local/x', '.local'],
    ['http://127.0.0.1/x', 'loopback'],
    ['http://0.0.0.0/x', '0.0.0.0'],
    ['http://10.0.0.5/x', 'private 10/8'],
    ['http://172.16.5.4/x', 'private 172.16/12'],
    ['http://192.168.1.1/x', 'private 192.168/16'],
    ['http://169.254.169.254/latest/meta-data', 'cloud metadata link-local'],
    ['http://100.64.0.1/x', 'CGNAT'],
    ['http://2130706433/x', 'decimal-encoded 127.0.0.1'],
    ['http://0x7f000001/x', 'hex-encoded loopback'],
    ['http://[::1]/x', 'IPv6 loopback'],
    ['http://[fd00::1]/x', 'IPv6 ULA'],
  ])('rejects %s (%s)', (url) => {
    expect(() => assertSafeImageUrl(url)).toThrow();
  });

  it('rejects malformed URLs', () => {
    expect(() => assertSafeImageUrl('not a url')).toThrow(/invalid/i);
  });
});
