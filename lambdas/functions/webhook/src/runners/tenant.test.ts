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
  it('should return disabled outcome when TENANT_TABLE_NAME is not set', async () => {
    delete process.env.TENANT_TABLE_NAME;

    const result = await getTenantCached(12345);

    expect(result).toEqual({ outcome: 'disabled' });
    expect(mockDocClient).not.toHaveReceivedCommand(GetCommand);
  });

  it('should return found outcome with tenant config when found', async () => {
    process.env.TENANT_TABLE_NAME = 'test-tenants';
    mockDocClient.on(GetCommand).resolves({
      Item: sampleTenant,
    });

    const result = await getTenantCached(12345);

    expect(result).toEqual({ outcome: 'found', tenant: sampleTenant });
    expect(mockDocClient).toHaveReceivedCommandWith(GetCommand, {
      TableName: 'test-tenants',
      Key: { installation_id: 12345 },
    });
  });

  it('should return not_found outcome when tenant not found', async () => {
    process.env.TENANT_TABLE_NAME = 'test-tenants';
    mockDocClient.on(GetCommand).resolves({
      Item: undefined,
    });

    const result = await getTenantCached(99999);

    expect(result).toEqual({ outcome: 'not_found' });
  });

  it('should cache tenant lookups', async () => {
    process.env.TENANT_TABLE_NAME = 'test-tenants';
    mockDocClient.on(GetCommand).resolves({
      Item: sampleTenant,
    });

    // First call - should hit DynamoDB
    const result1 = await getTenantCached(12345);
    expect(result1).toEqual({ outcome: 'found', tenant: sampleTenant });

    // Second call - should use cache
    const result2 = await getTenantCached(12345);
    expect(result2).toEqual({ outcome: 'found', tenant: sampleTenant });

    // Should only have called DynamoDB once
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1);
  });

  it('should return lookup_error outcome on DynamoDB failure for graceful degradation', async () => {
    process.env.TENANT_TABLE_NAME = 'test-tenants';
    const dynamoError = new Error('DynamoDB error');
    mockDocClient.on(GetCommand).rejects(dynamoError);

    const result = await getTenantCached(12345);

    expect(result.outcome).toBe('lookup_error');
    if (result.outcome === 'lookup_error') {
      expect(result.error).toBe(dynamoError);
    }
  });

  it('should refetch from DynamoDB after cache TTL expires', async () => {
    vi.useFakeTimers();
    process.env.TENANT_TABLE_NAME = 'test-tenants';
    mockDocClient.on(GetCommand).resolves({ Item: sampleTenant });

    // First call - populates cache
    await getTenantCached(12345);
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1);

    // Advance time past TTL (60001ms > 60000ms)
    vi.advanceTimersByTime(60001);

    // Second call - cache expired, should hit DynamoDB again
    await getTenantCached(12345);
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(2);

    vi.useRealTimers();
  });

  it('should evict oldest entry when cache exceeds MAX_CACHE_SIZE', async () => {
    process.env.TENANT_TABLE_NAME = 'test-tenants';
    mockDocClient.on(GetCommand).callsFake((input) => ({
      Item: { ...sampleTenant, installation_id: input.Key.installation_id },
    }));

    // Populate cache with 1000 entries (MAX_CACHE_SIZE)
    for (let i = 1; i <= 1000; i++) {
      await getTenantCached(i);
    }
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1000);

    // Add 1001st - should evict entry #1
    await getTenantCached(1001);
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1001);

    // Entry #2 should still be cached
    await getTenantCached(2);
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1001);

    // Entry #1 was evicted - should refetch
    await getTenantCached(1);
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1002);
  });

  it('should not evict entries when refreshing an expired key in a full cache', async () => {
    vi.useFakeTimers();
    process.env.TENANT_TABLE_NAME = 'test-tenants';
    mockDocClient.on(GetCommand).callsFake((input) => ({
      Item: { ...sampleTenant, installation_id: input.Key.installation_id },
    }));

    // Populate cache with 1000 entries (MAX_CACHE_SIZE)
    for (let i = 1; i <= 1000; i++) {
      await getTenantCached(i);
    }
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1000);

    // Advance time past TTL (60001ms > 60000ms) to expire all entries
    vi.advanceTimersByTime(60001);

    // Refresh entry #500 (existing but expired key)
    await getTenantCached(500);
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1001);

    // Entry #1 should still be in cache (expired but not evicted)
    // When we refresh it, it should trigger a DynamoDB call but NOT evict another entry
    await getTenantCached(1);
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1002);

    // Entry #2 should also still be cached (expired) - refreshing it should work
    await getTenantCached(2);
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1003);

    // All entries are still in cache (just refreshed), no evictions occurred
    // Now add a truly NEW entry #1001 - this should trigger eviction
    await getTenantCached(1001);
    expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1004);

    vi.useRealTimers();
  });
});
