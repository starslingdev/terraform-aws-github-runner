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
 * Internal helper to look up tenant by installation ID with fail-closed behavior.
 *
 * @param installationId - The GitHub App installation ID
 * @param identifier - A string identifier for error messages (tenantId or installationId)
 * @returns TenantConfig if found, null if not in multi-tenant mode
 * @throws TenantLookupError if tenant not found or DynamoDB error (fail-closed)
 */
async function lookupTenant(installationId: number, identifier: string): Promise<TenantConfig | null> {
  const tableName = process.env.TENANT_TABLE_NAME;
  if (!tableName) {
    if (!loggedNonMultiTenantMode) {
      logger.debug('Running in non-multi-tenant mode (TENANT_TABLE_NAME not set)');
      loggedNonMultiTenantMode = true;
    }
    return null;
  }

  try {
    const tenant = await getTenantCached(installationId);

    if (!tenant) {
      logger.warn('Tenant not found in registry', { installationId, identifier });
      throw new TenantLookupError(`Tenant not found: ${identifier}`, identifier);
    }

    return tenant;
  } catch (error) {
    if (error instanceof TenantLookupError) {
      throw error;
    }
    logger.error('DynamoDB error fetching tenant', { error, installationId, identifier });
    throw new TenantLookupError(`Failed to fetch tenant config: ${identifier}`, identifier);
  }
}

/**
 * Get tenant configuration by tenant ID (string).
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
  if (!tenantId) {
    throw new TenantLookupError('Missing tenantId in multi-tenant mode', '');
  }

  const installationId = parseInt(tenantId, 10);
  if (isNaN(installationId)) {
    throw new TenantLookupError(`Invalid tenant ID format: ${tenantId}`, tenantId);
  }

  return lookupTenant(installationId, tenantId);
}

export function isMultiTenantMode(): boolean {
  return !!process.env.TENANT_TABLE_NAME;
}

/**
 * Get tenant configuration by installation ID (number).
 *
 * This function is used when the webhook gracefully degraded and didn't include tenantId,
 * but scale-up needs to do fail-closed validation using the installationId from the message.
 *
 * Behavior:
 * - If TENANT_TABLE_NAME is not set (non-multi-tenant mode): returns null
 * - If TENANT_TABLE_NAME is set (multi-tenant mode):
 *   - Success: returns TenantConfig
 *   - Tenant not found: throws TenantLookupError
 *   - DynamoDB error: throws TenantLookupError
 */
export async function getTenantConfigByInstallationId(installationId: number): Promise<TenantConfig | null> {
  if (!installationId || installationId === 0) {
    throw new TenantLookupError('Missing installationId in multi-tenant mode', String(installationId));
  }

  return lookupTenant(installationId, String(installationId));
}

// For testing purposes - clears the in-memory cache (delegates to tenant-registry)
export function clearTenantCache(): void {
  clearRegistryCache();
}

// For testing purposes - resets the non-multi-tenant mode log flag
export function resetLoggedNonMultiTenantMode(): void {
  loggedNonMultiTenantMode = false;
}
