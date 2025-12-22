import { createAppAuth, type AppAuthentication, type InstallationAccessTokenAuthentication } from '@octokit/auth-app';
import type { OctokitOptions } from '@octokit/core';
import type { RequestInterface } from '@octokit/types';

// Define types that are not directly exported
type AppAuthOptions = { type: 'app' };
type InstallationAuthOptions = { type: 'installation'; installationId?: number };
// Use a more generalized AuthInterface to match what createAppAuth returns
type AuthInterface = {
  (options: AppAuthOptions): Promise<AppAuthentication>;
  (options: InstallationAuthOptions): Promise<InstallationAccessTokenAuthentication>;
};
type StrategyOptions = {
  appId: number;
  privateKey: string;
  installationId?: number;
  request?: RequestInterface;
};
import { request } from '@octokit/request';
import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { createChildLogger, tracer } from '@aws-github-runner/aws-powertools-util';
import { getParameter } from '@aws-github-runner/aws-ssm-util';
import { EndpointDefaults } from '@octokit/types';

const logger = createChildLogger('gh-auth');

export async function createOctokitClient(token: string, ghesApiUrl = ''): Promise<Octokit> {
  const CustomOctokit = Octokit.plugin(throttling);
  const ocktokitOptions: OctokitOptions = {
    auth: token,
  };
  if (ghesApiUrl) {
    ocktokitOptions.baseUrl = ghesApiUrl;
    ocktokitOptions.previews = ['antiope'];
  }

  return new CustomOctokit({
    ...ocktokitOptions,
    userAgent: process.env.USER_AGENT || 'github-aws-runners',
    throttle: {
      onRateLimit: (retryAfter: number, options: Required<EndpointDefaults>) => {
        logger.warn(
          `GitHub rate limit: Request quota exhausted for request ${options.method} ${options.url}. Requested `,
        );
      },
      onSecondaryRateLimit: (retryAfter: number, options: Required<EndpointDefaults>) => {
        logger.warn(`GitHub rate limit: SecondaryRateLimit detected for request ${options.method} ${options.url}`);
      },
    },
  });
}

export async function createGithubAppAuth(
  installationId: number | undefined,
  ghesApiUrl = '',
): Promise<AppAuthentication> {
  const subsegment = tracer.getSegment()?.addNewSubsegment('github_app_auth');
  try {
    const auth = await createAuth(installationId, ghesApiUrl);
    const appAuthOptions: AppAuthOptions = { type: 'app' };
    return await auth(appAuthOptions);
  } finally {
    subsegment?.close();
  }
}

export async function createGithubInstallationAuth(
  installationId: number | undefined,
  ghesApiUrl = '',
): Promise<InstallationAccessTokenAuthentication> {
  const subsegment = tracer.getSegment()?.addNewSubsegment('github_installation_auth');
  try {
    const auth = await createAuth(installationId, ghesApiUrl);
    const installationAuthOptions: InstallationAuthOptions = { type: 'installation', installationId };
    return await auth(installationAuthOptions);
  } finally {
    subsegment?.close();
  }
}

async function createAuth(installationId: number | undefined, ghesApiUrl: string): Promise<AuthInterface> {
  const subsegment = tracer.getSegment()?.addNewSubsegment('ssm_fetch_github_credentials');
  try {
    const appId = parseInt(await getParameter(process.env.PARAMETER_GITHUB_APP_ID_NAME));
    let authOptions: StrategyOptions = {
      appId,
      privateKey: Buffer.from(
        await getParameter(process.env.PARAMETER_GITHUB_APP_KEY_BASE64_NAME),
        'base64',
        // replace literal \n characters with new lines to allow the key to be stored as a
        // single line variable. This logic should match how the GitHub Terraform provider
        // processes private keys to retain compatibility between the projects
      )
        .toString()
        .replace('/[\\n]/g', String.fromCharCode(10)),
    };
    if (installationId) authOptions = { ...authOptions, installationId };

    logger.debug(`GHES API URL: ${ghesApiUrl}`);
    if (ghesApiUrl) {
      authOptions.request = request.defaults({
        baseUrl: ghesApiUrl,
      });
    }
    return createAppAuth(authOptions);
  } finally {
    subsegment?.close();
  }
}
