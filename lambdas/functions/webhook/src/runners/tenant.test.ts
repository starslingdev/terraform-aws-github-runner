import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest/vitest';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getTenantCached, clearTenantCache, type TenantConfig } from './tenant';

const mockDocClient = mockClient(DynamoDBDocumentClient);
const cleanEnv = process.env;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockDocClient.reset();
  clearTenantCache();
  process.env = { ...cleanEnv };
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

describe('getTenantCached', () => {
  it('should return null when TENANT_TABLE_NAME is not set', async () => {
    delete process.env.TENANT_TABLE_NAME;

    const result = await getTenantCached(12345);

    expect(result).toBeNull();
    expect(mockDocClient).not.toHaveReceivedCommand(GetCommand);
  });

  it('should return tenant config when found', async () => {
    process.env.TENANT_TABLE_NAME = 'test-tenants';
    mockDocClient.on(GetCommand).resolves({
      Item: sampleTenant,
    });

    const result = await getTenantCached(12345);

    expect(result).toEqual(sampleTenant);
    expect(mockDocClient).toHaveReceivedCommandWith(GetCommand, {
      TableName: 'test-tenants',
      Key: { installation_id: 12345 },
    });
  });

  it('should return null when tenant not found', async () => {
    process.env.TENANT_TABLE_NAME = 'test-tenants';
    mockDocClient.on(GetCommand).resolves({
      Item: undefined,
    });

    const result = await getTenantCached(99999);

    expect(result).toBeNull();
  });

  it('should cache tenant lookups', async () => {
    process.env.TENANT_TABLE_NAME = 'test-tenants';
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

  it('should throw error on DynamoDB failure', async () => {
    process.env.TENANT_TABLE_NAME = 'test-tenants';
    mockDocClient.on(GetCommand).rejects(new Error('DynamoDB error'));

    await expect(getTenantCached(12345)).rejects.toThrow('DynamoDB error');
  });
});
