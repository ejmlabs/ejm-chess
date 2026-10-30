import { describe, expect, it } from 'vitest';
import { accountPath, playReturnPath } from '../src/client/accountPath';

const game = 'a12b34c5-d67e-4f89-9123-456789abcdef';

describe('account return paths', () => {
  it('rejects external, protocol-relative, and executable destinations', () => {
    for (const value of [
      'https://outside.example/play/',
      'https://chess.ejmlabs.com/play/',
      '//outside.example/play/',
      'javascript:alert(1)',
      'data:text/html,hello',
      'play/?format=rapid',
    ]) expect(playReturnPath(value), value).toBeNull();
  });

  it('rejects backslash and encoded redirect paths', () => {
    for (const value of [
      '/\\outside.example/play/',
      '/%5C%5Coutside.example/play/',
      '/%2F%2Foutside.example/play/',
      '/play/%2e%2e/%2f%2foutside.example',
      '%2Fplay%2F%3Fformat%3Drapid',
    ]) expect(playReturnPath(value), value).toBeNull();
  });

  it('rejects other routes and malformed invitation IDs', () => {
    for (const value of [
      '/account/', '/admin/', '/play/another/',
      '/play/?game=', '/play/?game=not-a-game',
      `/play/?game=${game}%2F..%2Fadmin`,
    ]) expect(playReturnPath(value), value).toBeNull();
    expect(playReturnPath(null)).toBeNull();
  });

  it('preserves a valid invitation and supported time control', () => {
    expect(playReturnPath(`/play/?game=${game}&format=rapid`)).toBe(`/play/?game=${game}&format=rapid`);
    expect(playReturnPath('/play?format=blitz')).toBe('/play/?format=blitz');
    expect(playReturnPath('/play/')).toBe('/play/');
  });

  it('drops private values, nested redirects, fragments, and unsupported formats', () => {
    expect(playReturnPath(`/play/?game=${game}&format=rapid&token=private&returnTo=%2F%5Coutside.example#private`))
      .toBe(`/play/?game=${game}&format=rapid`);
    expect(playReturnPath('/play/?format=unsupported&next=https%3A%2F%2Foutside.example')).toBe('/play/');
  });

  it('builds account links with only an approved return path', () => {
    const url = new URL(accountPath(`/play/?game=${game}&format=rapid&token=private`, 'sign-up'), 'https://chess.ejmlabs.com');
    expect(url.pathname).toBe('/account/');
    expect(url.searchParams.get('returnTo')).toBe(`/play/?game=${game}&format=rapid`);
    expect(url.searchParams.get('view')).toBe('sign-up');
    expect(accountPath('//outside.example/play/', 'sign-in')).toBe('/account/?view=sign-in');
    expect(accountPath()).toBe('/account/');
  });
});
