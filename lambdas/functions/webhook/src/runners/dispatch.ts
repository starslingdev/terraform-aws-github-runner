import { createChildLogger } from '@aws-github-runner/aws-powertools-util';
import { WorkflowJobEvent } from '@octokit/webhooks-types';

import { Response } from '../lambda';
import { RunnerMatcherConfig, sendActionRequest } from '../sqs';
import ValidationError from '../ValidationError';
import { ConfigDispatcher, ConfigWebhook } from '../ConfigLoader';
import { getTenantCached, TenantConfig } from './tenant';

const logger = createChildLogger('handler');

export async function dispatch(
  event: WorkflowJobEvent,
  eventType: string,
  config: ConfigDispatcher | ConfigWebhook,
): Promise<Response> {
  // Validate tenant if multi-tenant mode is enabled
  const tenant = await validateTenant(event);

  validateRepoInAllowList(event, config);

  return await handleWorkflowJob(event, eventType, config.matcherConfig!, tenant);
}

async function validateTenant(event: WorkflowJobEvent): Promise<TenantConfig | null> {
  const installationId = event.installation?.id;

  // In multi-tenant mode, installation_id is required. We check this before calling
  // getTenantCached because we need the installationId for the lookup.
  // Note: getTenantCached will return 'disabled' if TENANT_TABLE_NAME is not set.
  if (!installationId) {
    // Only error if multi-tenant mode is enabled
    if (process.env.TENANT_TABLE_NAME) {
      logger.warn('Missing installation_id in webhook payload');
      throw new ValidationError(400, 'Missing installation_id in webhook payload');
    }
    // Non-multi-tenant mode: proceed without tenant validation
    return null;
  }

  const result = await getTenantCached(installationId);

  switch (result.outcome) {
    case 'disabled':
      // Multi-tenant mode not enabled (TENANT_TABLE_NAME not set)
      return null;

    case 'found': {
      const tenant = result.tenant;
      if (tenant.status !== 'active') {
        logger.warn('Tenant not active', { installationId, status: tenant.status });
        throw new ValidationError(403, `Tenant ${tenant.org_name} is ${tenant.status}`);
      }
      logger.info('Tenant validated', {
        installationId,
        orgName: tenant.org_name,
        tier: tenant.tier,
      });
      return tenant;
    }

    case 'not_found':
      // Legitimate unknown tenant - reject with 403
      logger.warn('Unknown tenant', { installationId });
      throw new ValidationError(403, `Unknown tenant for installation ${installationId}`);

    case 'lookup_error':
      // GRACEFUL DEGRADATION: DynamoDB error, queue job anyway
      // Scale-up Lambda will do fail-closed validation using installationId
      logger.warn('Tenant lookup failed, gracefully degrading', {
        installationId,
        error: result.error?.message,
      });
      return null;
  }
}

function validateRepoInAllowList(event: WorkflowJobEvent, config: ConfigDispatcher) {
  if (config.repositoryAllowList.length > 0 && !config.repositoryAllowList.includes(event.repository.full_name)) {
    logger.info(`Received event from unauthorized repository ${event.repository.full_name}`);
    throw new ValidationError(403, `Received event from unauthorized repository ${event.repository.full_name}`);
  }
}

async function handleWorkflowJob(
  body: WorkflowJobEvent,
  githubEvent: string,
  matcherConfig: Array<RunnerMatcherConfig>,
  tenant: TenantConfig | null,
): Promise<Response> {
  if (body.action !== 'queued') {
    return {
      statusCode: 201,
      body: `Workflow job not queued, not dispatching to queue.`,
    };
  }

  logger.debug(
    `Processing workflow job event - Repository: ${body.repository.full_name}, ` +
      `Job ID: ${body.workflow_job.id}, Job Name: ${body.workflow_job.name}, ` +
      `Run ID: ${body.workflow_job.run_id}, Labels: ${JSON.stringify(body.workflow_job.labels)}` +
      (tenant ? `, Tenant: ${tenant.org_name}` : ''),
  );
  // sort the queuesConfig by order of matcher config exact match, with all true matches lined up ahead.
  matcherConfig.sort((a, b) => {
    return a.matcherConfig.exactMatch === b.matcherConfig.exactMatch ? 0 : a.matcherConfig.exactMatch ? -1 : 1;
  });
  for (const queue of matcherConfig) {
    if (canRunJob(body.workflow_job.labels, queue.matcherConfig.labelMatchers, queue.matcherConfig.exactMatch)) {
      await sendActionRequest({
        id: body.workflow_job.id,
        repositoryName: body.repository.name,
        repositoryOwner: body.repository.owner.login,
        eventType: githubEvent,
        installationId: body.installation?.id ?? 0,
        queueId: queue.id,
        repoOwnerType: body.repository.owner.type,
        tenantId: tenant ? String(tenant.installation_id) : undefined,
        tenantTier: tenant?.tier,
      });
      logger.info(
        `Successfully dispatched job for ${body.repository.full_name} to the queue ${queue.id} - ` +
          `Job ID: ${body.workflow_job.id}, Job Name: ${body.workflow_job.name}, Run ID: ${body.workflow_job.run_id}` +
          (tenant ? `, Tenant: ${tenant.org_name}` : ''),
      );
      return {
        statusCode: 201,
        body: `Successfully queued job for ${body.repository.full_name} to the queue ${queue.id}`,
      };
    }
  }
  const notAcceptedErrorMsg = `Received event contains runner labels '${body.workflow_job.labels}' from '${
    body.repository.full_name
  }' that are not accepted.`;
  logger.warn(
    `${notAcceptedErrorMsg} - Job ID: ${body.workflow_job.id}, Job Name: ${body.workflow_job.name}, Run ID: ${body.workflow_job.run_id}`,
  );
  return { statusCode: 202, body: notAcceptedErrorMsg };
}

export function canRunJob(
  workflowJobLabels: string[],
  runnerLabelsMatchers: string[][],
  workflowLabelCheckAll: boolean,
): boolean {
  runnerLabelsMatchers = runnerLabelsMatchers.map((runnerLabel) => {
    return runnerLabel.map((label) => label.toLowerCase());
  });
  const matchLabels = workflowLabelCheckAll
    ? runnerLabelsMatchers.some((rl) => workflowJobLabels.every((wl) => rl.includes(wl.toLowerCase())))
    : runnerLabelsMatchers.some((rl) => workflowJobLabels.some((wl) => rl.includes(wl.toLowerCase())));
  const match = workflowJobLabels.length === 0 ? !matchLabels : matchLabels;

  logger.debug(
    `Received workflow job event with labels: '${JSON.stringify(workflowJobLabels)}'. The event does ${
      match ? '' : 'NOT '
    }match the runner labels: '${Array.from(runnerLabelsMatchers).join(',')}'`,
  );
  return match;
}
