import { describe, expect, it } from 'vitest';
import { isProductionResource } from '../src/server/production-resources';

describe('isProductionResource', () => {
  it.each([undefined, '', ' , ,'])('refuses every target when PRODUCTION_RESOURCE_IDS is %j', value => {
    const env = { PRODUCTION_RESOURCE_IDS: value };
    expect(isProductionResource(env, 'any-id')).toBe(true);
    expect(isProductionResource(env, 'a', 'b', 'c')).toBe(true);
    expect(isProductionResource(env)).toBe(true);
  });

  it('refuses only listed ids when the setting is populated', () => {
    const env = { PRODUCTION_RESOURCE_IDS: 'prod-a, prod-b' };
    expect(isProductionResource(env, 'prod-b')).toBe(true);
    expect(isProductionResource(env, 'other', 'prod-a')).toBe(true);
    expect(isProductionResource(env, 'other')).toBe(false);
  });
});
