import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest/vitest';

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getTenantConfig,
  isMultiTenantMode,
  clearTenantCache,
  resetLoggedNonMultiTenantMode,
  TenantLookupError,
  type TenantConfig,
} from './tenant';

const mockDocClient = mockClient(DynamoDBDocumentClient);
const cleanEnv = process.env;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockDocClient.reset();
  clearTenantCache();
  resetLoggedNonMultiTenantMode();
  process.env = { ...cleanEnv };
  process.env.AWS_REGION = 'us-east-1';
});

afterEach(() => {
  vi.useRealTimers();
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
  describe('non-multi-tenant mode (TENANT_TABLE_NAME not set)', () => {
    it('should return null when TENANT_TABLE_NAME is not set', async () => {
      delete process.env.TENANT_TABLE_NAME;

      const result = await getTenantConfig('12345');

      expect(result).toBeNull();
      expect(mockDocClient).not.toHaveReceivedCommand(GetCommand);
    });
  });

  describe('multi-tenant mode (TENANT_TABLE_NAME set)', () => {
    beforeEach(() => {
      process.env.TENANT_TABLE_NAME = 'test-tenants';
    });

    it('should throw TenantLookupError when tenantId is empty', async () => {
      await expect(getTenantConfig('')).rejects.toThrow(TenantLookupError);
      await expect(getTenantConfig('')).rejects.toThrow('Missing tenantId in multi-tenant mode');
      expect(mockDocClient).not.toHaveReceivedCommand(GetCommand);
    });

    it('should throw TenantLookupError when tenantId is invalid format', async () => {
      await expect(getTenantConfig('not-a-number')).rejects.toThrow(TenantLookupError);
      await expect(getTenantConfig('not-a-number')).rejects.toThrow('Invalid tenant ID format');
      expect(mockDocClient).not.toHaveReceivedCommand(GetCommand);
    });

    it('should return tenant config when found', async () => {
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

    it('should throw TenantLookupError when tenant not found (fail-closed)', async () => {
      mockDocClient.on(GetCommand).resolves({
        Item: undefined,
      });

      await expect(getTenantConfig('99999')).rejects.toThrow(TenantLookupError);
      await expect(getTenantConfig('99999')).rejects.toThrow('Tenant not found: 99999');
    });

    it('should throw TenantLookupError on DynamoDB error (fail-closed)', async () => {
      mockDocClient.on(GetCommand).rejects(new Error('DynamoDB error'));

      await expect(getTenantConfig('12345')).rejects.toThrow(TenantLookupError);
      await expect(getTenantConfig('12345')).rejects.toThrow('Failed to fetch tenant config: 12345');
    });

    it('should cache tenant lookups', async () => {
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

    it('should refetch from DynamoDB after cache TTL expires', async () => {
      vi.useFakeTimers();
      mockDocClient.on(GetCommand).resolves({ Item: sampleTenant });

      await getTenantConfig('12345');
      expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1);

      vi.advanceTimersByTime(60001);

      await getTenantConfig('12345');
      expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(2);
    });

    it('should evict oldest entry when cache exceeds MAX_CACHE_SIZE', async () => {
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

    it('should delete cache entry when tenant not found', async () => {
      // First, cache a valid tenant
      mockDocClient.on(GetCommand).resolvesOnce({ Item: sampleTenant });
      await getTenantConfig('12345');
      expect(mockDocClient.commandCalls(GetCommand)).toHaveLength(1);

      // Advance past cache TTL
      vi.useFakeTimers();
      vi.advanceTimersByTime(60001);

      // Tenant no longer exists
      mockDocClient.on(GetCommand).resolvesOnce({ Item: undefined });

      // Should throw and delete cache entry
      await expect(getTenantConfig('12345')).rejects.toThrow(TenantLookupError);
    });
  });

  describe('TenantLookupError', () => {
    it('should have correct name and tenantId properties', async () => {
      process.env.TENANT_TABLE_NAME = 'test-tenants';
      mockDocClient.on(GetCommand).resolves({ Item: undefined });

      try {
        await getTenantConfig('99999');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TenantLookupError);
        expect((error as TenantLookupError).name).toBe('TenantLookupError');
        expect((error as TenantLookupError).tenantId).toBe('99999');
      }
    });
  });
});
