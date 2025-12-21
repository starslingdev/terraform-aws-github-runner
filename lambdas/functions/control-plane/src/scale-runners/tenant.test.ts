import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest/vitest';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getTenantConfig, isMultiTenantMode, clearTenantCache, type TenantConfig } from './tenant';

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

describe('isMultiTenantMode', () => {
  it('should return true when TENANT_TABLE_NAME is set', () => {
    process.env.TENANT_TABLE_NAME = 'test-tenants';

    expect(isMultiTenantMode()).toBe(true);
  });

  it('should return false when TENANT_TABLE_NAME is not set', () => {
    delete process.env.TENANT_TABLE_NAME;

    expect(isMultiTenantMode()).toBe(false);
  });

  it('should return false when TENANT_TABLE_NAME is empty', () => {
    process.env.TENANT_TABLE_NAME = '';

    expect(isMultiTenantMode()).toBe(false);
  });
});

describe('getTenantConfig', () => {
  it('should return null when TENANT_TABLE_NAME is not set', async () => {
    delete process.env.TENANT_TABLE_NAME;

    const result = await getTenantConfig('12345');

    expect(result).toBeNull();
    expect(mockDocClient).not.toHaveReceivedCommand(GetCommand);
  });

  it('should return null when tenantId is empty', async () => {
    process.env.TENANT_TABLE_NAME = 'test-tenants';

    const result = await getTenantConfig('');

    expect(result).toBeNull();
    expect(mockDocClient).not.toHaveReceivedCommand(GetCommand);
  });

  it('should return tenant config when found', async () => {
    process.env.TENANT_TABLE_NAME = 'test-tenants';
    mockDocClient.on(GetCommand).resolves({
      Item: sampleTenant,
    });

    const result = await getTenantConfig('12345');

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

    const result = await getTenantConfig('99999');

    expect(result).toBeNull();
  });

  it('should cache tenant lookups', async () => {
    process.env.TENANT_TABLE_NAME = 'test-tenants';
    mockDocClient.on(GetCommand).resolves({
      Item: sampleTenant,
    });

    // First call - should hit DynamoDB
    const result1 = await getTenantConfig('12345');
    expect(result1).toEqual(sampleTenant);

    // Second call - should use cache
    const result2 = await getTenantConfig('12345');
    expect(result2).toEqual(sampleTenant);

    // Should only have called DynamoDB once
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1);
  });

  it('should return null on DynamoDB error (graceful degradation)', async () => {
    process.env.TENANT_TABLE_NAME = 'test-tenants';
    mockDocClient.on(GetCommand).rejects(new Error('DynamoDB error'));

    const result = await getTenantConfig('12345');

    expect(result).toBeNull();
  });

  it('should refetch from DynamoDB after cache TTL expires', async () => {
    vi.useFakeTimers();
    process.env.TENANT_TABLE_NAME = 'test-tenants';
    mockDocClient.on(GetCommand).resolves({ Item: sampleTenant });

    await getTenantConfig('12345');
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1);

    vi.advanceTimersByTime(60001);

    await getTenantConfig('12345');
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(2);

    vi.useRealTimers();
  });

  it('should evict oldest entry when cache exceeds MAX_CACHE_SIZE', async () => {
    process.env.TENANT_TABLE_NAME = 'test-tenants';
    mockDocClient.on(GetCommand).callsFake((input) => ({
      Item: { ...sampleTenant, installation_id: input.Key.installation_id },
    }));

    for (let i = 1; i <= 1000; i++) {
      await getTenantConfig(String(i));
    }
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1000);

    await getTenantConfig('1001');
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1001);

    await getTenantConfig('2'); // still cached
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1001);

    await getTenantConfig('1'); // evicted, refetch
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1002);
  });
});
