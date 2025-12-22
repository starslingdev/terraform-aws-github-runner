import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { getTracedAWSV3Client, createChildLogger } from '@aws-github-runner/aws-powertools-util';
import { TenantConfig, TenantStatus, TenantTier } from '@aws-github-runner/tenant-registry';

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
// Key is installation_id (number) for type consistency with DynamoDB
const tenantCache = new Map<number, { tenant: TenantConfig; expiry: number }>();
const CACHE_TTL_MS = 60000; // 1 minute
const MAX_CACHE_SIZE = parseInt(process.env.TENANT_CACHE_MAX_SIZE || '1000', 10) || 1000; // Fallback if NaN

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

  // Check cache first
  const cached = tenantCache.get(installationId);
  if (cached && cached.expiry > Date.now()) {
    logger.debug('Tenant cache hit', { tenantId, installationId });
    return cached.tenant;
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
      logger.warn('Tenant not found in registry', { tenantId, installationId });
      tenantCache.delete(installationId);
      throw new TenantLookupError(`Tenant not found: ${tenantId}`, tenantId);
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

// For testing purposes - clears the in-memory cache
export function clearTenantCache(): void {
  tenantCache.clear();
}

// For testing purposes - resets the non-multi-tenant mode log flag
export function resetLoggedNonMultiTenantMode(): void {
  loggedNonMultiTenantMode = false;
}
