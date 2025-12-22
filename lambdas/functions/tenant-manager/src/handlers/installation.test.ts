import { EC2Client, DescribeInstancesCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest/vitest';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleInstallation } from './installation';
import type { InstallationEventDetail } from '../lambda';

vi.mock('@aws-github-runner/tenant-registry', () => ({
  createTenant: vi.fn(),
  updateTenant: vi.fn(),
  getTenant: vi.fn(),
  invalidateTenantCache: vi.fn(),
}));

import { createTenant, updateTenant, invalidateTenantCache } from '@aws-github-runner/tenant-registry';

const mockEC2Client = mockClient(EC2Client);
const cleanEnv = process.env;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockEC2Client.reset();
  process.env = { ...cleanEnv };
  process.env.AWS_REGION = 'us-east-1';
});

const baseInstallation: InstallationEventDetail['installation'] = {
  id: 12345,
  account: {
    login: 'test-org',
    id: 67890,
    type: 'Organization',
  },
  app_id: 11111,
  target_type: 'Organization',
  permissions: {},
  events: [],
};

const baseSender: InstallationEventDetail['sender'] = {
  login: 'test-user',
  id: 99999,
  type: 'User',
};

describe('handleInstallation', () => {
  describe('installation.created', () => {
    it('should create a new tenant', async () => {
      const mockTenant = {
        installation_id: 12345,
        org_name: 'test-org',
        org_type: 'Organization' as const,
        status: 'active' as const,
        tier: 'small' as const,
        max_runners: 2,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };

      vi.mocked(createTenant).mockResolvedValue(mockTenant);

      const event: InstallationEventDetail = {
        action: 'created',
        installation: baseInstallation,
        sender: baseSender,
      };

      await handleInstallation(event);

      expect(createTenant).toHaveBeenCalledWith({
        installation_id: 12345,
        org_name: 'test-org',
        org_type: 'Organization',
        tier: 'small',
        metadata: {
          github_account_id: 67890,
          sender_login: 'test-user',
          sender_id: 99999,
        },
      });
    });
  });

  describe('installation.deleted', () => {
    it('should mark tenant as deleted and terminate runners', async () => {
      vi.mocked(updateTenant).mockResolvedValue({
        installation_id: 12345,
        org_name: 'test-org',
        org_type: 'Organization' as const,
        status: 'deleted' as const,
        tier: 'small' as const,
        max_runners: 2,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      });

      mockEC2Client.on(DescribeInstancesCommand).resolves({
        Reservations: [
          {
            Instances: [{ InstanceId: 'i-1234' }, { InstanceId: 'i-5678' }],
          },
        ],
      });
      mockEC2Client.on(TerminateInstancesCommand).resolves({});

      const event: InstallationEventDetail = {
        action: 'deleted',
        installation: baseInstallation,
        sender: baseSender,
      };

      await handleInstallation(event);

      expect(updateTenant).toHaveBeenCalledWith(12345, { status: 'deleted' });
      expect(invalidateTenantCache).toHaveBeenCalledWith(12345);
      expect(mockEC2Client).toHaveReceivedCommandWith(DescribeInstancesCommand, {
        Filters: [
          { Name: 'tag:ghr:tenant_id', Values: ['12345'] },
          { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] },
        ],
      });
      expect(mockEC2Client).toHaveReceivedCommandWith(TerminateInstancesCommand, {
        InstanceIds: ['i-1234', 'i-5678'],
      });
    });

    it('should handle no runners to terminate', async () => {
      vi.mocked(updateTenant).mockResolvedValue(null);

      mockEC2Client.on(DescribeInstancesCommand).resolves({
        Reservations: [],
      });

      const event: InstallationEventDetail = {
        action: 'deleted',
        installation: baseInstallation,
        sender: baseSender,
      };

      await handleInstallation(event);

      expect(updateTenant).toHaveBeenCalledWith(12345, { status: 'deleted' });
      expect(mockEC2Client).not.toHaveReceivedCommand(TerminateInstancesCommand);
    });
  });

  describe('installation.suspend', () => {
    it('should suspend tenant', async () => {
      vi.mocked(updateTenant).mockResolvedValue({
        installation_id: 12345,
        org_name: 'test-org',
        org_type: 'Organization' as const,
        status: 'suspended' as const,
        tier: 'small' as const,
        max_runners: 2,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      });

      const event: InstallationEventDetail = {
        action: 'suspend',
        installation: baseInstallation,
        sender: baseSender,
      };

      await handleInstallation(event);

      expect(updateTenant).toHaveBeenCalledWith(12345, { status: 'suspended' });
      expect(invalidateTenantCache).toHaveBeenCalledWith(12345);
    });
  });

  describe('installation.unsuspend', () => {
    it('should reactivate tenant', async () => {
      vi.mocked(updateTenant).mockResolvedValue({
        installation_id: 12345,
        org_name: 'test-org',
        org_type: 'Organization' as const,
        status: 'active' as const,
        tier: 'small' as const,
        max_runners: 2,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      });

      const event: InstallationEventDetail = {
        action: 'unsuspend',
        installation: baseInstallation,
        sender: baseSender,
      };

      await handleInstallation(event);

      expect(updateTenant).toHaveBeenCalledWith(12345, { status: 'active' });
      expect(invalidateTenantCache).toHaveBeenCalledWith(12345);
    });
  });

  describe('unknown action', () => {
    it('should ignore unknown actions', async () => {
      const event: InstallationEventDetail = {
        action: 'new_permissions_accepted' as InstallationEventDetail['action'],
        installation: baseInstallation,
        sender: baseSender,
      };

      await handleInstallation(event);

      expect(createTenant).not.toHaveBeenCalled();
      expect(updateTenant).not.toHaveBeenCalled();
    });
  });
});
