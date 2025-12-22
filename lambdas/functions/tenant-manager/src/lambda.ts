import middy from '@middy/core';
import { logger, setContext, captureLambdaHandler, tracer } from '@aws-github-runner/aws-powertools-util';
import { Context, EventBridgeEvent } from 'aws-lambda';
import { handleInstallation } from './handlers/installation';

export interface InstallationEventDetail {
  action: 'created' | 'deleted' | 'suspend' | 'unsuspend' | 'new_permissions_accepted';
  installation: {
    id: number;
    account: {
      login: string;
      id: number;
      type: 'Organization' | 'User';
    };
    app_id: number;
    target_type: string;
    permissions: Record<string, string>;
    events: string[];
  };
  sender: {
    login: string;
    id: number;
    type: string;
  };
}

async function handler(
  event: EventBridgeEvent<'installation', InstallationEventDetail>,
  context: Context,
): Promise<void> {
  setContext(context, 'tenant-manager');
  logger.info('Processing installation event', {
    action: event.detail.action,
    installationId: event.detail.installation.id,
    account: event.detail.installation.account.login,
  });

  try {
    await handleInstallation(event.detail);
    logger.info('Successfully processed installation event');
  } catch (error) {
    logger.error('Failed to process installation event', { error });
    throw error;
  }
}

export const lambdaHandler = middy(handler).use(captureLambdaHandler(tracer));
