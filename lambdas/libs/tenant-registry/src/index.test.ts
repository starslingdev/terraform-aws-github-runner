import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest/vitest';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getTenant,
  createTenant,
  updateTenant,
  listTenantsByStatus,
  getTenantByOrgName,
  getTenantCached,
  invalidateTenantCache,
  clearTenantCache,
  TIER_LIMITS,
  type TenantConfig,
} from '.';

const mockDocClient = mockClient(DynamoDBDocumentClient);
const cleanEnv = process.env;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockDocClient.reset();
  clearTenantCache();
  process.env = { ...cleanEnv };
  process.env.TENANT_TABLE_NAME = 'test-tenants';
  process.env.AWS_REGION = 'us-east-1';
});

const sampleTenant: TenantConfig = {
  installation_id: 12345,
  org_name: 'test-org',
  org_type: 'Organization',
  status: 'active',
  tier: 'small',
  max_runners: 2,
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
};

describe('TIER_LIMITS', () => {
  it('should have correct limits for each tier', () => {
    expect(TIER_LIMITS.small).toBe(2);
    expect(TIER_LIMITS.medium).toBe(5);
    expect(TIER_LIMITS.large).toBe(10);
  });
});

describe('getTenant', () => {
  it('should return tenant config when found', async () => {
    mockDocClient.on(GetCommand).resolves({
      Item: sampleTenant,
    });

    const result = await getTenant(12345);

    expect(result).toEqual(sampleTenant);
    expect(mockDocClient).toHaveReceivedCommandWith(GetCommand, {
      TableName: 'test-tenants',
      Key: { installation_id: 12345 },
    });
  });

  it('should return null when tenant not found', async () => {
    mockDocClient.on(GetCommand).resolves({
      Item: undefined,
    });

    const result = await getTenant(99999);

    expect(result).toBeNull();
  });

  it('should throw error on DynamoDB failure', async () => {
    mockDocClient.on(GetCommand).rejects(new Error('DynamoDB error'));

    await expect(getTenant(12345)).rejects.toThrow('DynamoDB error');
  });
});

describe('createTenant', () => {
  it('should create tenant with default tier', async () => {
    mockDocClient.on(PutCommand).resolves({});

    const result = await createTenant({
      installation_id: 12345,
      org_name: 'test-org',
      org_type: 'Organization',
    });

    expect(result.installation_id).toBe(12345);
    expect(result.org_name).toBe('test-org');
    expect(result.status).toBe('active');
    expect(result.tier).toBe('small');
    expect(result.max_runners).toBe(2);
    expect(mockDocClient).toHaveReceivedCommandWith(PutCommand, {
      TableName: 'test-tenants',
      ConditionExpression: 'attribute_not_exists(installation_id)',
    });
  });

  it('should create tenant with specified tier', async () => {
    mockDocClient.on(PutCommand).resolves({});

    const result = await createTenant({
      installation_id: 12345,
      org_name: 'test-org',
      org_type: 'Organization',
      tier: 'large',
    });

    expect(result.tier).toBe('large');
    expect(result.max_runners).toBe(10);
  });

  it('should return existing tenant on duplicate', async () => {
    const error = new Error('ConditionalCheckFailedException');
    error.name = 'ConditionalCheckFailedException';
    mockDocClient.on(PutCommand).rejects(error);
    mockDocClient.on(GetCommand).resolves({
      Item: sampleTenant,
    });

    const result = await createTenant({
      installation_id: 12345,
      org_name: 'test-org',
      org_type: 'Organization',
    });

    expect(result).toEqual(sampleTenant);
  });
});

describe('updateTenant', () => {
  it('should update tenant status', async () => {
    mockDocClient.on(UpdateCommand).resolves({
      Attributes: { ...sampleTenant, status: 'suspended' },
    });

    const result = await updateTenant(12345, { status: 'suspended' });

    expect(result?.status).toBe('suspended');
    expect(mockDocClient).toHaveReceivedCommand(UpdateCommand);
  });

  it('should update tier and auto-update max_runners', async () => {
    mockDocClient.on(UpdateCommand).resolves({
      Attributes: { ...sampleTenant, tier: 'large', max_runners: 10 },
    });

    const result = await updateTenant(12345, { tier: 'large' });

    expect(result?.tier).toBe('large');
    expect(result?.max_runners).toBe(10);
  });

  it('should update max_runners independently', async () => {
    mockDocClient.on(UpdateCommand).resolves({
      Attributes: { ...sampleTenant, max_runners: 15 },
    });

    const result = await updateTenant(12345, { max_runners: 15 });

    expect(result?.max_runners).toBe(15);
  });
});

describe('listTenantsByStatus', () => {
  it('should query tenants by status', async () => {
    mockDocClient.on(QueryCommand).resolves({
      Items: [sampleTenant],
    });

    const result = await listTenantsByStatus('active');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(sampleTenant);
    expect(mockDocClient).toHaveReceivedCommandWith(QueryCommand, {
      TableName: 'test-tenants',
      IndexName: 'status-index',
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': 'active' },
    });
  });

  it('should return empty array when no tenants found', async () => {
    mockDocClient.on(QueryCommand).resolves({
      Items: [],
    });

    const result = await listTenantsByStatus('deleted');

    expect(result).toHaveLength(0);
  });
});

describe('getTenantByOrgName', () => {
  it('should query tenant by org name', async () => {
    mockDocClient.on(QueryCommand).resolves({
      Items: [sampleTenant],
    });

    const result = await getTenantByOrgName('test-org');

    expect(result).toEqual(sampleTenant);
    expect(mockDocClient).toHaveReceivedCommandWith(QueryCommand, {
      TableName: 'test-tenants',
      IndexName: 'org-name-index',
      KeyConditionExpression: 'org_name = :orgName',
      ExpressionAttributeValues: { ':orgName': 'test-org' },
    });
  });

  it('should return null when org not found', async () => {
    mockDocClient.on(QueryCommand).resolves({
      Items: [],
    });

    const result = await getTenantByOrgName('unknown-org');

    expect(result).toBeNull();
  });
});

describe('getTenantCached', () => {
  it('should cache tenant lookups', async () => {
    mockDocClient.on(GetCommand).resolves({
      Item: sampleTenant,
    });

    // First call - should hit DynamoDB
    const result1 = await getTenantCached(12345);
    expect(result1).toEqual(sampleTenant);

    // Second call - should use cache
    const result2 = await getTenantCached(12345);
    expect(result2).toEqual(sampleTenant);

    // Should only have called DynamoDB once
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1);
  });

  it('should return null for non-existent tenant', async () => {
    mockDocClient.on(GetCommand).resolves({
      Item: undefined,
    });

    const result = await getTenantCached(99999);

    expect(result).toBeNull();
  });
});

describe('invalidateTenantCache', () => {
  it('should invalidate cached tenant', async () => {
    mockDocClient.on(GetCommand).resolves({
      Item: sampleTenant,
    });

    // First call - cache the tenant
    await getTenantCached(12345);

    // Invalidate the cache
    invalidateTenantCache(12345);

    // Next call should hit DynamoDB again
    await getTenantCached(12345);

    // Should have called DynamoDB twice
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(2);
  });
});
