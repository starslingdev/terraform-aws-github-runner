import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getTracedAWSV3Client, createChildLogger } from '@aws-github-runner/aws-powertools-util';

const logger = createChildLogger('tenant-registry');

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
  metadata?: {
    github_account_id?: number;
    sender_login?: string;
    sender_id?: number;
  };
}

export interface CreateTenantInput {
  installation_id: number;
  org_name: string;
  org_type: 'Organization' | 'User';
  tier?: TenantTier;
  metadata?: TenantConfig['metadata'];
}

export interface UpdateTenantInput {
  status?: TenantStatus;
  tier?: TenantTier;
  max_runners?: number;
}

// Default tier limits
export const TIER_LIMITS: Record<TenantTier, number> = {
  small: 2,
  medium: 5,
  large: 10,
};

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

function getTableName(): string {
  const tableName = process.env.TENANT_TABLE_NAME;
  if (!tableName) {
    throw new Error('TENANT_TABLE_NAME environment variable not set');
  }
  return tableName;
}

export async function getTenant(installationId: number): Promise<TenantConfig | null> {
  const client = getDocClient();
  const tableName = getTableName();

  try {
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

    return result.Item as TenantConfig;
  } catch (error) {
    logger.error('Failed to get tenant', { error, installationId });
    throw error;
  }
}

export async function createTenant(input: CreateTenantInput): Promise<TenantConfig> {
  const client = getDocClient();
  const tableName = getTableName();

  const tier = input.tier || 'small';
  const now = new Date().toISOString();

  const tenant: TenantConfig = {
    installation_id: input.installation_id,
    org_name: input.org_name,
    org_type: input.org_type,
    status: 'active',
    tier: tier,
    max_runners: TIER_LIMITS[tier],
    created_at: now,
    updated_at: now,
    metadata: input.metadata,
  };

  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: tenant,
        ConditionExpression: 'attribute_not_exists(installation_id)',
      }),
    );

    logger.info('Tenant created', {
      installationId: input.installation_id,
      orgName: input.org_name,
      tier,
    });

    return tenant;
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') {
      logger.warn('Tenant already exists', { installationId: input.installation_id });
      const existing = await getTenant(input.installation_id);
      if (existing) return existing;
    }
    logger.error('Failed to create tenant', { error, input });
    throw error;
  }
}

export async function updateTenant(installationId: number, updates: UpdateTenantInput): Promise<TenantConfig | null> {
  const client = getDocClient();
  const tableName = getTableName();

  const updateExpressions: string[] = ['updated_at = :now'];
  const expressionAttributeValues: Record<string, unknown> = {
    ':now': new Date().toISOString(),
  };

  if (updates.status !== undefined) {
    updateExpressions.push('#status = :status');
    expressionAttributeValues[':status'] = updates.status;
  }

  if (updates.tier !== undefined) {
    updateExpressions.push('tier = :tier');
    expressionAttributeValues[':tier'] = updates.tier;
  }

  // Handle max_runners: use explicit value if provided, otherwise derive from tier
  if (updates.max_runners !== undefined) {
    updateExpressions.push('max_runners = :max_runners');
    expressionAttributeValues[':max_runners'] = updates.max_runners;
  } else if (updates.tier !== undefined) {
    // Auto-update max_runners based on tier when not explicitly set
    updateExpressions.push('max_runners = :max_runners');
    expressionAttributeValues[':max_runners'] = TIER_LIMITS[updates.tier];
  }

  try {
    const result = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { installation_id: installationId },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeValues: expressionAttributeValues,
        ExpressionAttributeNames: updates.status !== undefined ? { '#status': 'status' } : undefined,
        ConditionExpression: 'attribute_exists(installation_id)',
        ReturnValues: 'ALL_NEW',
      }),
    );

    logger.info('Tenant updated', { installationId, updates });
    return result.Attributes as TenantConfig;
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') {
      logger.warn('Tenant not found for update', { installationId });
      return null;
    }
    logger.error('Failed to update tenant', { error, installationId, updates });
    throw error;
  }
}

export async function listTenantsByStatus(status: TenantStatus): Promise<TenantConfig[]> {
  const client = getDocClient();
  const tableName = getTableName();

  try {
    const allItems: TenantConfig[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'status-index',
          KeyConditionExpression: '#status = :status',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':status': status },
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );

      allItems.push(...((result.Items || []) as TenantConfig[]));
      lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);

    return allItems;
  } catch (error) {
    logger.error('Failed to list tenants by status', { error, status });
    throw error;
  }
}

export async function getTenantByOrgName(orgName: string): Promise<TenantConfig | null> {
  const client = getDocClient();
  const tableName = getTableName();

  try {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'org-name-index',
        KeyConditionExpression: 'org_name = :orgName',
        ExpressionAttributeValues: { ':orgName': orgName },
      }),
    );

    if (!result.Items || result.Items.length === 0) {
      return null;
    }

    return result.Items[0] as TenantConfig;
  } catch (error) {
    logger.error('Failed to get tenant by org name', { error, orgName });
    throw error;
  }
}

// Cache for tenant lookups (in-memory, per Lambda instance)
const tenantCache = new Map<number, { tenant: TenantConfig; expiry: number }>();
const CACHE_TTL_MS = 60000; // 1 minute
const parsedCacheSize = parseInt(process.env.TENANT_CACHE_MAX_SIZE || '1000', 10);
const MAX_CACHE_SIZE = Number.isNaN(parsedCacheSize) || parsedCacheSize < 1 ? 1000 : parsedCacheSize;

export async function getTenantCached(installationId: number): Promise<TenantConfig | null> {
  const cached = tenantCache.get(installationId);
  if (cached && cached.expiry > Date.now()) {
    return cached.tenant;
  }

  const tenant = await getTenant(installationId);
  if (tenant) {
    // Evict oldest entry if cache is full and this is a new key
    if (tenantCache.size >= MAX_CACHE_SIZE && !tenantCache.has(installationId)) {
      const oldestKey = tenantCache.keys().next().value;
      if (oldestKey !== undefined) tenantCache.delete(oldestKey);
    }

    tenantCache.set(installationId, {
      tenant,
      expiry: Date.now() + CACHE_TTL_MS,
    });
  } else {
    tenantCache.delete(installationId);
  }

  return tenant;
}

export function invalidateTenantCache(installationId: number): void {
  tenantCache.delete(installationId);
}

// For testing purposes - clears the entire in-memory cache
export function clearTenantCache(): void {
  tenantCache.clear();
}
