import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { getTracedAWSV3Client, createChildLogger } from '@aws-github-runner/aws-powertools-util';

const logger = createChildLogger('tenant');

export type TenantStatus = 'active' | 'suspended' | 'deleted';
export type TenantTier = 'small' | 'medium' | 'large';

export interface TenantConfig {
  installation_id: number;
  org_name: string;
  org_type: 'Organization' | 'User';
  status: TenantStatus;
  tier: TenantTier;
  max_runners: number;
  created_at: string;
  updated_at: string;
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
const tenantCache = new Map<number, { tenant: TenantConfig; expiry: number }>();
const CACHE_TTL_MS = 60000; // 1 minute

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
      return null;
    }

    const tenant = result.Item as TenantConfig;
    tenantCache.set(installationId, {
      tenant,
      expiry: Date.now() + CACHE_TTL_MS,
    });

    return tenant;
  } catch (error) {
    logger.error('Failed to get tenant', { error, installationId });
    throw error;
  }
}

// For testing purposes - clears the in-memory cache
export function clearTenantCache(): void {
  tenantCache.clear();
}
