import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { getTracedAWSV3Client, createChildLogger } from '@aws-github-runner/aws-powertools-util';
import { TenantConfig, TenantStatus, TenantTier } from '@aws-github-runner/tenant-registry';

// Re-export types for use by dispatch.ts and other modules
export { TenantConfig, TenantStatus, TenantTier };

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
 * This function uses graceful degradation (fail-open) - it returns null on errors
 * rather than throwing. This is intentional for the webhook Lambda since:
 * 1. Webhook is the first line of defense and should remain available during DynamoDB outages
 * 2. Scale-up Lambda provides fail-closed enforcement as the final guard
 */
export async function getTenantCached(installationId: number): Promise<TenantConfig | null> {
  const cached = tenantCache.get(installationId);
  if (cached && cached.expiry > Date.now()) {
    logger.debug('Tenant cache hit', { installationId });
    return cached.tenant;
  }

  const tableName = process.env.TENANT_TABLE_NAME;
  if (!tableName) {
    logger.debug('TENANT_TABLE_NAME not set, skipping tenant lookup');
    return null;
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
      return null;
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

    return tenant;
  } catch (error) {
    logger.error('Failed to get tenant', { error, installationId });
    // Return null instead of throwing - allows graceful degradation
    // This prevents DynamoDB connectivity issues from crashing webhook processing
    // Scale-up Lambda provides fail-closed enforcement as the final guard
    return null;
  }
}

// For testing purposes - clears the in-memory cache
export function clearTenantCache(): void {
  tenantCache.clear();
}
