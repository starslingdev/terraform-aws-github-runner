Our self-hosted examples/multi-tenant-runner system is successfully running in production for the test workflow but it takes too long to start executing the job. 

Optimize the code to reduce the time it takes to start executing the job without compromising the security to less than 10 seconds. Focus on solutions that completely eliminate EC2 instance boot time and starting the runner.

Timing Breakdown for Job https://github.com/starslingdev/terraform-aws-github-runner/actions/runs/20447577262

Timing Breakdown (Pre-baked AMI)

| Phase                    | Start (UTC) | End (UTC) | Duration    | Source                               |
|--------------------------|-------------|-----------|-------------|--------------------------------------|
| 1. GitHub → Webhook      | 00:20:37    | 00:20:40  | ~3s         | workflow_job queued → Lambda invoked |
| 2. Webhook Processing    | 00:20:40    | 00:20:41  | 1.3s        | Lambda execution (cold start + SQS)  |
| 3. SQS → Scale-up Lambda | 00:20:41    | 00:20:44  | ~3s         | SQS delivery + cold start (543ms)    |
| 4. Scale-up Lambda       | 00:20:44    | 00:20:48  | 4.4s        | EC2 Fleet API call                   |
| 5. EC2 Instance Boot     | 00:20:48    | 00:21:04  | ~16s        | Launch → OS boot → start-runner.sh   |
| 6. User Data (dnf)       | —           | —         | 0s          | ELIMINATED (pre-baked AMI)           |
| 7. Runner Install        | —           | —         | 0s          | ELIMINATED (pre-baked AMI)           |
| 8. Start Runner Script   | 00:21:04    | 00:21:28  | 24.3s       | IMDS/SSM/CloudWatch/config           |
| 9. Runner Ready          | 00:21:28    | 00:21:28  | 0s          | "Listening for Jobs"                 |
| 10. Job Assignment       | 00:21:28    | 00:21:31  | ~3s         | GitHub → runner pickup               |
| 11. Job Execution        | 00:21:31    | 00:21:38  | 7s          | checkout + test steps                |
| Total                    | 00:20:37    | 00:21:38  | 61s (1m 1s) |                                      |

Detailed Instrumentation Output (JSON Logs)

| Phase                  | Duration (s) | Status | Details               |
|------------------------|--------------|--------|-----------------------|
| imds_token             | 0.01         | ok     | retries: 0            |
| metadata_ami_id        | 0.01         | ok     |                       |
| metadata_region        | 0.01         | ok     |                       |
| metadata_instance_id   | 0.01         | ok     |                       |
| metadata_instance_type | 0.01         | ok     |                       |
| metadata_az            | 0.01         | ok     |                       |
| tags_environment       | 0.01         | ok     |                       |
| tags_ssm_config_path   | 0.01         | ok     |                       |
| tags_retrieval_imds    | 0.04         | ok     |                       |
| ssm_get_parameters     | 1.73         | ok     |                       |
| ssm_jq_parse           | 0.02         | ok     |                       |
| cloudwatch_agent_start | 16.11        | ok     | New bottleneck        |
| ssm_config_polling     | 0.86         | ok     | poll_count: 0         |
| chown_runner           | 0.93         | ok     |                       |
| runner_ready           | 3.69         | ok     | boot_to_ready: 24.31s |
| metrics_emission       | 0.56         | ok     | metric_count: 5       |
| total_boot_time        | 34.46        | ok     | start-runner.sh       |

Improvement vs Previous (Before Pre-baked AMI)

| Metric                 | Before        | After       | Improvement       |
|------------------------|---------------|-------------|-------------------|
| Total time             | 114s (1m 54s) | 61s (1m 1s) | 53s faster (46%)  |
| User Data (dnf/docker) | 75s           | 0s          | 75s eliminated    |
| Runner Install (S3)    | 11.5s         | 0s          | 11.5s eliminated  |
| Start Runner Script    | 6.7s          | 24.3s       | +17.6s (CW agent) |
| CloudWatch agent start | 0.93s         | 16.11s      | Now visible*      |
| Job execution          | 7s            | 7s          | No change         |

*CloudWatch agent startup was previously hidden within the 75s dnf phase. It's now the primary bottleneck.

Quick Reference: Generate Timing Breakdown for GitHub Workflow Job

1. Get workflow run details

gh run view <RUN_ID> --repo <OWNER>/<REPO>
gh api repos/<OWNER>/<REPO>/actions/runs/<RUN_ID>/jobs | jq '.jobs[0] | {name, started_at, completed_at, runner_name}'

2. Get webhook Lambda timing

aws logs describe-log-streams --log-group-name "/aws/lambda/<PREFIX>-webhook" \
  --region <REGION> --order-by LastEventTime --descending --limit 1 \
  --query 'logStreams[0].logStreamName' --output text

aws logs get-log-events --log-group-name "/aws/lambda/<PREFIX>-webhook" \
  --log-stream-name '<STREAM_NAME>' --region <REGION> --limit 30 \
  --query 'events[*].[timestamp,message]' --output json | \
  jq -r '.[] | "\(.[0] / 1000 | strftime("%H:%M:%S")) \(.[1])"'

3. Get scale-up Lambda timing

aws logs describe-log-streams --log-group-name "/aws/lambda/<PREFIX>-<TIER>-scale-up" \
  --region <REGION> --order-by LastEventTime --descending --limit 1 \
  --query 'logStreams[0].logStreamName' --output text

aws logs get-log-events --log-group-name "/aws/lambda/<PREFIX>-<TIER>-scale-up" \
  --log-stream-name '<STREAM_NAME>' --region <REGION> --limit 50 \
  --query 'events[*].[timestamp,message]' --output json | \
  jq -r '.[] | "\(.[0] / 1000 | strftime("%H:%M:%S")) \(.[1])"'

4. Get runner startup instrumentation

bash -c 'aws logs filter-log-events \
  --log-group-name "/github-self-hosted-runners/<PREFIX>-<TIER>/runner-startup" \
  --region <REGION> \
  --start-time $(($(date +%s) - 1800))000 \
  --query "events[*].message" --output text'

Variables to replace

- <RUN_ID>: GitHub workflow run ID (e.g., 20447577262)
- <OWNER>/<REPO>: GitHub repo (e.g., starslingdev/terraform-aws-github-runner)
- <PREFIX>: Runner environment prefix (e.g., sling-gh-runner)
- <TIER>: Runner tier (e.g., small, medium, large)
- <REGION>: AWS region (e.g., us-west-2)