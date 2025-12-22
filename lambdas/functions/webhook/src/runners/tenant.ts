import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { getTracedAWSV3Client, createChildLogger } from '@aws-github-runner/aws-powertools-util';
import { TenantConfig, TenantStatus, TenantTier } from '@aws-github-runner/tenant-registry';

// Re-export types for use by dispatch.ts and other modules
export { TenantConfig, TenantStatus, TenantTier };

/**
 * Discriminated union type for tenant lookup results.
 * This allows callers to distinguish between:
 * - 'found': Tenant exists and was successfully retrieved
 * - 'not_found': Tenant does not exist in DynamoDB (legitimate 403)
 * - 'lookup_error': DynamoDB error occurred (should gracefully degrade)
 * - 'disabled': Multi-tenant mode is not enabled
 */
export type TenantLookupResult =
  | { outcome: 'found'; tenant: TenantConfig }
  | { outcome: 'not_found' }
  | { outcome: 'lookup_error'; error?: Error }
  | { outcome: 'disabled' };

const logger = createChildLogger('tenant');

let docClient: DynamoDBDocumentClient | null = null;

function getDocClient(): DynamoDBDocumentClient {
  if (!docClient) {
    const client = getTracedAWSV3Client(new DynamoDBClient({ region: process.env.AWS_REGION }));
    docClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: {
        removeUndefinedValues: true,
      },
    });
  }
  return docClient;
}

// Cache for tenant lookups (in-memory, per Lambda instance)
const tenantCache = new Map<number, { tenant: TenantConfig; expiry: number }>();
const CACHE_TTL_MS = 60000; // 1 minute
const MAX_CACHE_SIZE = 1000; // Prevent unbounded cache growth

/**
 * Get tenant configuration with caching.
 *
 * This function returns a discriminated union to distinguish between:
 * - 'found': Tenant exists and was successfully retrieved
 * - 'not_found': Tenant does not exist in DynamoDB (legitimate unknown tenant)
 * - 'lookup_error': DynamoDB error occurred (infrastructure failure)
 * - 'disabled': Multi-tenant mode is not enabled (TENANT_TABLE_NAME not set)
 *
 * This distinction allows the webhook to:
 * 1. Reject unknown tenants with 403 (not_found)
 * 2. Gracefully degrade during DynamoDB outages (lookup_error)
 * 3. Scale-up Lambda provides fail-closed enforcement as the final guard
 */
export async function getTenantCached(installationId: number): Promise<TenantLookupResult> {
  const cached = tenantCache.get(installationId);
  if (cached && cached.expiry > Date.now()) {
    logger.debug('Tenant cache hit', { installationId });
    return { outcome: 'found', tenant: cached.tenant };
  }

  const tableName = process.env.TENANT_TABLE_NAME;
  if (!tableName) {
    logger.debug('TENANT_TABLE_NAME not set, skipping tenant lookup');
    return { outcome: 'disabled' };
  }

  try {
    const client = getDocClient();
    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { installation_id: installationId },
      }),
    );

    if (!result.Item) {
      logger.debug('Tenant not found', { installationId });
      tenantCache.delete(installationId);
      return { outcome: 'not_found' };
    }

    const tenant = result.Item as TenantConfig;

    // Evict oldest entry if cache is full and this is a new key
    if (tenantCache.size >= MAX_CACHE_SIZE && !tenantCache.has(installationId)) {
      const oldestKey = tenantCache.keys().next().value;
      if (oldestKey !== undefined) tenantCache.delete(oldestKey);
    }

    tenantCache.set(installationId, {
      tenant,
      expiry: Date.now() + CACHE_TTL_MS,
    });

    return { outcome: 'found', tenant };
  } catch (error) {
    logger.error('Failed to get tenant', { error, installationId });
    // Return lookup_error instead of throwing - allows graceful degradation
    // This prevents DynamoDB connectivity issues from crashing webhook processing
    // Scale-up Lambda provides fail-closed enforcement as the final guard
    return { outcome: 'lookup_error', error: error as Error };
  }
}

// For testing purposes - clears the in-memory cache
export function clearTenantCache(): void {
  tenantCache.clear();
}
