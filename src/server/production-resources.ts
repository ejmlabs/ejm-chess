/**
 * Comma-separated production database and namespace ids, supplied by the private Worker
 * configuration. An unset or empty list matches every id, so isolated runs fail closed.
 */
export interface ProductionResourceEnv { PRODUCTION_RESOURCE_IDS?: string }

export function isProductionResource(env: ProductionResourceEnv, ...ids: readonly string[]): boolean {
  const known = new Set((env.PRODUCTION_RESOURCE_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean));
  return known.size === 0 || ids.some(id => known.has(id));
}
