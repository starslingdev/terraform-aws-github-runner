import { createChildLogger } from '@aws-github-runner/aws-powertools-util';
import {
  TenantConfig,
  TenantStatus,
  TenantTier,
  getTenantCached,
  clearTenantCache as clearRegistryCache,
} from '@aws-github-runner/tenant-registry';

export { TenantConfig, TenantStatus, TenantTier };

const logger = createChildLogger('tenant');

/**
 * Error thrown when tenant lookup fails in multi-tenant mode.
 * This error signals that scale-up should reject the messages (fail-closed behavior).
 */
export class TenantLookupError extends Error {
  constructor(
    message: string,
    public readonly tenantId: string,
  ) {
    super(message);
    this.name = 'TenantLookupError';
  }
}

let loggedNonMultiTenantMode = false;

/**
 * Get tenant configuration by tenant ID.
 *
 * Behavior:
 * - If TENANT_TABLE_NAME is not set (non-multi-tenant mode): returns null
 * - If TENANT_TABLE_NAME is set (multi-tenant mode):
 *   - Success: returns TenantConfig
 *   - Tenant not found: throws TenantLookupError
 *   - DynamoDB error: throws TenantLookupError
 *
 * This fail-closed behavior ensures that in multi-tenant mode, runner creation
 * is blocked when tenant validation fails, preventing unbounded runner creation.
 */
export async function getTenantConfig(tenantId: string): Promise<TenantConfig | null> {
  // Skip tenant lookup if not in multi-tenant mode
  const tableName = process.env.TENANT_TABLE_NAME;
  if (!tableName) {
    if (!loggedNonMultiTenantMode) {
      logger.debug('Running in non-multi-tenant mode (TENANT_TABLE_NAME not set)');
      loggedNonMultiTenantMode = true;
    }
    return null;
  }

  // In multi-tenant mode, tenantId is required
  if (!tenantId) {
    throw new TenantLookupError('Missing tenantId in multi-tenant mode', tenantId || '');
  }

  const installationId = parseInt(tenantId, 10);
  if (isNaN(installationId)) {
    throw new TenantLookupError(`Invalid tenant ID format: ${tenantId}`, tenantId);
  }

  try {
    // Use the tenant-registry library's cached lookup
    const tenant = await getTenantCached(installationId);

    if (!tenant) {
      logger.warn('Tenant not found in registry', { tenantId, installationId });
      throw new TenantLookupError(`Tenant not found: ${tenantId}`, tenantId);
    }

    return tenant;
  } catch (error) {
    // Re-throw TenantLookupError as-is
    if (error instanceof TenantLookupError) {
      throw error;
    }
    // Wrap DynamoDB errors in TenantLookupError for fail-closed behavior
    logger.error('DynamoDB error fetching tenant', { error, tenantId, installationId });
    throw new TenantLookupError(`Failed to fetch tenant config: ${tenantId}`, tenantId);
  }
}

export function isMultiTenantMode(): boolean {
  return !!process.env.TENANT_TABLE_NAME;
}

// For testing purposes - clears the in-memory cache (delegates to tenant-registry)
export function clearTenantCache(): void {
  clearRegistryCache();
}

// For testing purposes - resets the non-multi-tenant mode log flag
export function resetLoggedNonMultiTenantMode(): void {
  loggedNonMultiTenantMode = false;
}
