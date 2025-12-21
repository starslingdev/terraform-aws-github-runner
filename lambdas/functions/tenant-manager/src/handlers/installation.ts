import { createChildLogger } from '@aws-github-runner/aws-powertools-util';
import { createTenant, updateTenant, invalidateTenantCache } from '@aws-github-runner/tenant-registry';
import { EC2Client, DescribeInstancesCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import { getTracedAWSV3Client } from '@aws-github-runner/aws-powertools-util';
import { InstallationEventDetail } from '../lambda';

const logger = createChildLogger('installation-handler');

export async function handleInstallation(event: InstallationEventDetail): Promise<void> {
  const { action, installation, sender } = event;

  switch (action) {
    case 'created':
      await handleInstallationCreated(installation, sender);
      break;
    case 'deleted':
      await handleInstallationDeleted(installation);
      break;
    case 'suspend':
      await handleInstallationSuspended(installation);
      break;
    case 'unsuspend':
      await handleInstallationUnsuspended(installation);
      break;
    default:
      logger.info('Ignoring installation event action', { action });
  }
}

async function handleInstallationCreated(
  installation: InstallationEventDetail['installation'],
  sender: InstallationEventDetail['sender'],
): Promise<TenantConfig> {
  logger.info('Processing new installation', {
    installationId: installation.id,
    account: installation.account.login,
    accountType: installation.account.type,
  });

  const tenant = await createTenant({
    installation_id: installation.id,
    org_name: installation.account.login,
    org_type: installation.account.type,
    tier: 'small', // Default tier for new installations
    metadata: {
      github_account_id: installation.account.id,
      sender_login: sender.login,
      sender_id: sender.id,
    },
  });

  logger.info('Tenant onboarded successfully', {
    installationId: tenant.installation_id,
    orgName: tenant.org_name,
    tier: tenant.tier,
    maxRunners: tenant.max_runners,
  });

  return tenant;
}

async function handleInstallationDeleted(installation: InstallationEventDetail['installation']): Promise<void> {
  logger.info('Processing installation deletion', {
    installationId: installation.id,
    account: installation.account.login,
  });

  // Mark tenant as deleted
  await updateTenant(installation.id, { status: 'deleted' });
  invalidateTenantCache(installation.id);

  // Terminate any running runners for this tenant
  await terminateRunnersForTenant(installation.id);

  logger.info('Tenant offboarded successfully', {
    installationId: installation.id,
  });
}

async function handleInstallationSuspended(installation: InstallationEventDetail['installation']): Promise<void> {
  logger.info('Processing installation suspension', {
    installationId: installation.id,
    account: installation.account.login,
  });

  await updateTenant(installation.id, { status: 'suspended' });
  invalidateTenantCache(installation.id);

  logger.info('Tenant suspended', { installationId: installation.id });
}

async function handleInstallationUnsuspended(installation: InstallationEventDetail['installation']): Promise<void> {
  logger.info('Processing installation unsuspension', {
    installationId: installation.id,
    account: installation.account.login,
  });

  await updateTenant(installation.id, { status: 'active' });
  invalidateTenantCache(installation.id);

  logger.info('Tenant reactivated', { installationId: installation.id });
}

async function terminateRunnersForTenant(installationId: number): Promise<void> {
  const ec2Client = getTracedAWSV3Client(new EC2Client({ region: process.env.AWS_REGION }));

  try {
    // Find running instances with this tenant's tag
    const describeResult = await ec2Client.send(
      new DescribeInstancesCommand({
        Filters: [
          {
            Name: 'tag:ghr:tenant_id',
            Values: [String(installationId)],
          },
          {
            Name: 'instance-state-name',
            Values: ['pending', 'running', 'stopping', 'stopped'],
          },
        ],
      }),
    );

    const instanceIds: string[] = [];
    for (const reservation of describeResult.Reservations || []) {
      for (const instance of reservation.Instances || []) {
        if (instance.InstanceId) {
          instanceIds.push(instance.InstanceId);
        }
      }
    }

    if (instanceIds.length === 0) {
      logger.info('No runners to terminate for tenant', { installationId });
      return;
    }

    logger.info('Terminating runners for tenant', {
      installationId,
      instanceCount: instanceIds.length,
      instanceIds,
    });

    await ec2Client.send(
      new TerminateInstancesCommand({
        InstanceIds: instanceIds,
      }),
    );

    logger.info('Runners terminated', {
      installationId,
      instanceCount: instanceIds.length,
    });
  } catch (error) {
    logger.error('Failed to terminate runners for tenant', {
      error,
      installationId,
    });
    // Don't throw - we still want to mark the tenant as deleted
  }
}
