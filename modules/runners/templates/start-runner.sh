#!/bin/bash

# =============================================================================
# Boot Timing Instrumentation Framework
# =============================================================================
# All timing data is output as single-line JSON for CloudWatch Logs Insights
# Format: {"ts":"...", "phase":"...", "duration_s":1.23, "status":"ok|error", ...}
# =============================================================================

BOOT_START_TIME=$(date +%s.%N)

# Associative array for batched CloudWatch metrics
declare -A BOOT_METRICS

# X-Ray tracing state (set after daemon starts)
XRAY_TRACE_ID=""
XRAY_SEGMENT_ID=""
XRAY_SEGMENT_DOC=""

# -----------------------------------------------------------------------------
# log_json - Output a JSON log line with timing data
# -----------------------------------------------------------------------------
log_json() {
  local phase="$1"
  local duration="$2"
  local status="${3:-ok}"
  local extra="${4:-}"

  local base
  base=$(printf '{"ts":"%s","phase":"%s","duration_s":%s,"status":"%s","instance_id":"%s","env":"%s"' \
    "$(date -Iseconds)" "$phase" "$duration" "$status" "${instance_id:-unknown}" "${environment:-unknown}")

  if [[ -n "$extra" ]]; then
    echo "${base},${extra}}"
  else
    echo "${base}}"
  fi
}

# -----------------------------------------------------------------------------
# timed_exec - Execute a command and log its timing
# Usage: output=$(timed_exec "phase_name" command args...)
# Returns: command output on stdout, logs JSON to stderr
# -----------------------------------------------------------------------------
timed_exec() {
  local phase="$1"; shift
  local start_time end_time duration exit_code=0 output=""

  start_time=$(date +%s.%N)
  output=$("$@" 2>&1) || exit_code=$?
  end_time=$(date +%s.%N)
  duration=$(echo "$end_time - $start_time" | bc)

  local status="ok"
  [[ $exit_code -ne 0 ]] && status="error"

  # Log to stderr so stdout can be captured
  log_json "$phase" "$duration" "$status" "\"exit_code\":$exit_code" >&2

  # Emit X-Ray subsegment if tracing enabled
  [[ -n "$XRAY_SEGMENT_ID" ]] && emit_xray_subsegment "$phase" "$start_time" "$end_time" "$status"

  # Return output on stdout
  echo "$output"
  return $exit_code
}

# -----------------------------------------------------------------------------
# timed_retry - Execute a command with retries and log timing + retry stats
# Usage: output=$(timed_retry "phase_name" max_retries sleep_seconds command args...)
# -----------------------------------------------------------------------------
timed_retry() {
  local phase="$1"
  local max_retries="$2"
  local sleep_sec="$3"
  shift 3

  local start_time end_time duration
  local attempt=0 total_sleep=0 exit_code=1 output=""

  start_time=$(date +%s.%N)

  while [[ $attempt -lt $max_retries ]]; do
    attempt=$((attempt + 1))
    output=$("$@" 2>&1) && exit_code=0 || exit_code=$?

    # Success - break out
    [[ $exit_code -eq 0 ]] && break

    # Failed but more retries available - sleep and continue
    if [[ $attempt -lt $max_retries ]]; then
      sleep "$sleep_sec"
      total_sleep=$((total_sleep + sleep_sec))
    fi
  done

  end_time=$(date +%s.%N)
  duration=$(echo "$end_time - $start_time" | bc)

  local status="ok"
  [[ $exit_code -ne 0 ]] && status="error"

  local retries=$((attempt - 1))
  log_json "$phase" "$duration" "$status" "\"exit_code\":$exit_code,\"retries\":$retries,\"total_sleep_s\":$total_sleep" >&2

  # Emit X-Ray subsegment if tracing enabled
  [[ -n "$XRAY_SEGMENT_ID" ]] && emit_xray_subsegment "$phase" "$start_time" "$end_time" "$status"

  echo "$output"
  return $exit_code
}

# -----------------------------------------------------------------------------
# collect_metric - Store a metric for batched emission
# -----------------------------------------------------------------------------
collect_metric() {
  local name="$1"
  local value="$2"
  BOOT_METRICS["$name"]="$value"
}

# -----------------------------------------------------------------------------
# emit_all_metrics - Emit all collected metrics in a single CloudWatch API call
# -----------------------------------------------------------------------------
emit_all_metrics() {
  [[ ${#BOOT_METRICS[@]} -eq 0 ]] && return
  [[ -z "$region" || "$region" == "unknown" ]] && return

  local metric_start metric_end metric_duration
  metric_start=$(date +%s.%N)

  # Build metric data JSON array
  local metric_data="["
  local first=true
  for name in "${!BOOT_METRICS[@]}"; do
    [[ "$first" != "true" ]] && metric_data+=","
    first=false
    metric_data+="{\"MetricName\":\"$name\",\"Value\":${BOOT_METRICS[$name]},\"Unit\":\"Seconds\",\"Dimensions\":[{\"Name\":\"InstanceId\",\"Value\":\"$instance_id\"},{\"Name\":\"Environment\",\"Value\":\"$environment\"}]}"
  done
  metric_data+="]"

  # Single API call for all metrics
  aws cloudwatch put-metric-data \
    --namespace "GitHubRunners/BootTiming" \
    --metric-data "$metric_data" \
    --region "$region" 2>/dev/null || true

  metric_end=$(date +%s.%N)
  metric_duration=$(echo "$metric_end - $metric_start" | bc)
  log_json "metrics_emission" "$metric_duration" "ok" "\"metric_count\":${#BOOT_METRICS[@]}"
}

# -----------------------------------------------------------------------------
# X-Ray Functions - Use /dev/urandom and fractional timestamps
# -----------------------------------------------------------------------------
create_xray_start_segment() {
  local trace_id="$1"
  local inst_id="$2"

  # Use /dev/urandom to avoid blocking on low entropy
  local segment_id
  segment_id=$(dd if=/dev/urandom bs=8 count=1 2>/dev/null | od -An -tx1 | tr -d ' \t\n')

  # Use fractional epoch timestamp
  local start_time
  start_time=$(date +%s.%N)

  local segment_doc
  segment_doc="{\"trace_id\": \"$trace_id\", \"id\": \"$segment_id\", \"start_time\": $start_time, \"in_progress\": true, \"name\": \"Runner\", \"origin\": \"AWS::EC2::Instance\", \"aws\": {\"ec2\":{\"instance_id\":\"$inst_id\"}}}"

  echo '{"format": "json", "version": 1}' > /tmp/xray_segment.txt
  echo "$segment_doc" >> /tmp/xray_segment.txt
  cat /tmp/xray_segment.txt > /dev/udp/127.0.0.1/2000 2>/dev/null || true

  # Store for subsegment emission
  XRAY_TRACE_ID="$trace_id"
  XRAY_SEGMENT_ID="$segment_id"
  XRAY_SEGMENT_DOC="$segment_doc"

  echo "$segment_doc"
}

emit_xray_subsegment() {
  local name="$1" start="$2" end="$3" status="$4"
  [[ -z "$XRAY_TRACE_ID" ]] && return

  local subseg_id
  subseg_id=$(dd if=/dev/urandom bs=8 count=1 2>/dev/null | od -An -tx1 | tr -d ' \t\n')

  local error_flag="false"
  [[ "$status" == "error" ]] && error_flag="true"

  local doc="{\"trace_id\":\"$XRAY_TRACE_ID\",\"id\":\"$subseg_id\",\"parent_id\":\"$XRAY_SEGMENT_ID\",\"name\":\"$name\",\"start_time\":$start,\"end_time\":$end,\"error\":$error_flag,\"type\":\"subsegment\"}"

  echo '{"format":"json","version":1}' > /tmp/xray_subseg.txt
  echo "$doc" >> /tmp/xray_subseg.txt
  cat /tmp/xray_subseg.txt > /dev/udp/127.0.0.1/2000 2>/dev/null || true
}

create_xray_success_segment() {
  [[ -z "$XRAY_SEGMENT_DOC" ]] && return

  local end_time
  end_time=$(date +%s.%N)

  local segment_doc
  segment_doc=$(echo "$XRAY_SEGMENT_DOC" | jq -c ". + {\"end_time\": $end_time} | del(.in_progress)")

  echo '{"format": "json", "version": 1}' > /tmp/xray_segment.txt
  echo "$segment_doc" >> /tmp/xray_segment.txt
  cat /tmp/xray_segment.txt > /dev/udp/127.0.0.1/2000 2>/dev/null || true
}

create_xray_error_segment() {
  [[ -z "$XRAY_SEGMENT_DOC" ]] && return

  local message="$1"
  local end_time
  end_time=$(date +%s.%N)

  local error_obj="{\"exceptions\": [{\"message\": \"$message\"}]}"
  local segment_doc
  segment_doc=$(echo "$XRAY_SEGMENT_DOC" | jq -c ". + {\"end_time\": $end_time, \"error\": true, \"cause\": $error_obj} | del(.in_progress)")

  echo '{"format": "json", "version": 1}' > /tmp/xray_segment.txt
  echo "$segment_doc" >> /tmp/xray_segment.txt
  cat /tmp/xray_segment.txt > /dev/udp/127.0.0.1/2000 2>/dev/null || true
}

# -----------------------------------------------------------------------------
# tag_instance_with_runner_id - Tag EC2 instance with GitHub runner agent ID
# -----------------------------------------------------------------------------
tag_instance_with_runner_id() {
  echo "Checking for .runner file to extract agent ID"

  if [[ ! -f "/opt/actions-runner/.runner" ]]; then
    echo "Warning: .runner file not found"
    return 0
  fi

  echo "Found .runner file, extracting agent ID"
  local agent_id
  agent_id=$(jq -r '.agentId' /opt/actions-runner/.runner 2>/dev/null || echo "")

  if [[ -z "$agent_id" || "$agent_id" == "null" ]]; then
    echo "Warning: Could not extract agent ID from .runner file"
    return 0
  fi

  echo "Tagging instance with GitHub runner agent ID: $agent_id"
  local tag_start tag_end tag_duration
  tag_start=$(date +%s.%N)

  if aws ec2 create-tags \
    --region "$region" \
    --resources "$instance_id" \
    --tags Key=ghr:github_runner_id,Value="$agent_id"; then
    echo "Successfully tagged instance with agent ID: $agent_id"
  else
    echo "Warning: Failed to tag instance with agent ID"
  fi

  tag_end=$(date +%s.%N)
  tag_duration=$(echo "$tag_end - $tag_start" | bc)
  log_json "tag_runner_id" "$tag_duration" "ok"
}

# -----------------------------------------------------------------------------
# cleanup - Handle script exit
# -----------------------------------------------------------------------------
cleanup() {
  local exit_code="$1"
  local error_lineno="$2"

  if [[ "$exit_code" -ne 0 ]]; then
    echo "ERROR: runner-start-failed with exit code $exit_code at line $error_lineno"
    create_xray_error_segment "runner-start-failed with exit code $exit_code at line $error_lineno"
  fi

  # Allow CloudWatch logs and traces to flush
  sleep 10

  if [[ "$agent_mode" == "ephemeral" ]] || [[ "$exit_code" -ne 0 ]]; then
    echo "Stopping CloudWatch service"
    systemctl stop amazon-cloudwatch-agent.service || true
    echo "Terminating instance"
    aws ec2 terminate-instances \
      --instance-ids "$instance_id" \
      --region "$region" \
      || true
  fi
}

trap 'cleanup $? $LINENO' EXIT

# =============================================================================
# PHASE 1: IMDS Token Retrieval (with retry instrumentation)
# =============================================================================
echo "Retrieving IMDSv2 token from AWS API"
token=$(timed_retry "imds_token" 40 5 curl -sf -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 180")

if [[ -z "$token" ]]; then
  echo "FATAL: Failed to retrieve IMDS token after all retries"
  exit 1
fi

# =============================================================================
# PHASE 2: Metadata Queries (individual calls for granular timing)
# =============================================================================
ami_id=$(timed_exec "metadata_ami_id" curl -sf -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/ami-id)

region_doc=$(timed_exec "metadata_region" curl -sf -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/dynamic/instance-identity/document)
region=$(echo "$region_doc" | jq -r .region)
echo "Retrieved REGION from AWS API ($region)"

instance_id=$(timed_exec "metadata_instance_id" curl -sf -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/instance-id)
echo "Retrieved INSTANCE_ID from AWS API ($instance_id)"

instance_type=$(timed_exec "metadata_instance_type" curl -sf -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/instance-type)

availability_zone=$(timed_exec "metadata_az" curl -sf -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/placement/availability-zone)

# Collect total metadata time
METADATA_TOTAL_END=$(date +%s.%N)
METADATA_DURATION=$(echo "$METADATA_TOTAL_END - $BOOT_START_TIME" | bc)
collect_metric "MetadataRetrievalTime" "$METADATA_DURATION"

# =============================================================================
# PHASE 3: Tags Retrieval (split API call from jq parsing)
# =============================================================================
%{ if metadata_tags == "enabled" }
# Using instance metadata tags (faster)
TAGS_START=$(date +%s.%N)
environment=$(timed_exec "tags_environment" curl -sf -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/tags/instance/ghr:environment)
ssm_config_path=$(timed_exec "tags_ssm_config_path" curl -sf -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/tags/instance/ghr:ssm_config_path)
runner_name_prefix=$(curl -sf -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/tags/instance/ghr:runner_name_prefix || echo "")
xray_trace_id=$(curl -sf -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/tags/instance/ghr:trace_id || echo "")
TAGS_END=$(date +%s.%N)
TAGS_DURATION=$(echo "$TAGS_END - $TAGS_START" | bc)
log_json "tags_retrieval_imds" "$TAGS_DURATION" "ok"

%{ else }
# Using EC2 API describe-tags
tags=$(timed_exec "tags_api_call" aws ec2 describe-tags --region "$region" --filters "Name=resource-id,Values=$instance_id")
echo "Retrieved tags from AWS API"

# Time jq parsing separately
PARSE_START=$(date +%s.%N)
environment=$(echo "$tags" | jq -r '.Tags[] | select(.Key == "ghr:environment") | .Value')
ssm_config_path=$(echo "$tags" | jq -r '.Tags[] | select(.Key == "ghr:ssm_config_path") | .Value')
runner_name_prefix=$(echo "$tags" | jq -r '.Tags[] | select(.Key == "ghr:runner_name_prefix") | .Value' || echo "")
xray_trace_id=$(echo "$tags" | jq -r '.Tags[] | select(.Key == "ghr:trace_id") | .Value' || echo "")
PARSE_END=$(date +%s.%N)
PARSE_DURATION=$(echo "$PARSE_END - $PARSE_START" | bc)
log_json "tags_jq_parse" "$PARSE_DURATION" "ok"

%{ endif }

echo "Retrieved ghr:environment tag - ($environment)"
echo "Retrieved ghr:ssm_config_path tag - ($ssm_config_path)"
echo "Retrieved ghr:runner_name_prefix tag - ($runner_name_prefix)"

# =============================================================================
# PHASE 4: SSM Parameters Fetch (split API call from jq parsing)
# =============================================================================
parameters=$(timed_exec "ssm_get_parameters" aws ssm get-parameters-by-path --path "$ssm_config_path" --region "$region" --query "Parameters[*].{Name:Name,Value:Value}")
echo "Retrieved parameters from AWS SSM"

# Time jq parsing separately
SSM_PARSE_START=$(date +%s.%N)
run_as=$(echo "$parameters" | jq -r '.[] | select(.Name == "'$ssm_config_path'/run_as") | .Value')
enable_cloudwatch_agent=$(echo "$parameters" | jq -r '.[] | select(.Name == "'$ssm_config_path'/enable_cloudwatch") | .Value')
agent_mode=$(echo "$parameters" | jq -r '.[] | select(.Name == "'$ssm_config_path'/agent_mode") | .Value')
disable_default_labels=$(echo "$parameters" | jq -r '.[] | select(.Name == "'$ssm_config_path'/disable_default_labels") | .Value')
enable_jit_config=$(echo "$parameters" | jq -r '.[] | select(.Name == "'$ssm_config_path'/enable_jit_config") | .Value')
token_path=$(echo "$parameters" | jq -r '.[] | select(.Name == "'$ssm_config_path'/token_path") | .Value')
SSM_PARSE_END=$(date +%s.%N)
SSM_PARSE_DURATION=$(echo "$SSM_PARSE_END - $SSM_PARSE_START" | bc)
log_json "ssm_jq_parse" "$SSM_PARSE_DURATION" "ok"

echo "Retrieved /$ssm_config_path/run_as parameter - ($run_as)"
echo "Retrieved /$ssm_config_path/enable_cloudwatch parameter - ($enable_cloudwatch_agent)"
echo "Retrieved /$ssm_config_path/agent_mode parameter - ($agent_mode)"
echo "Retrieved /$ssm_config_path/disable_default_labels parameter - ($disable_default_labels)"
echo "Retrieved /$ssm_config_path/enable_jit_config parameter - ($enable_jit_config)"
echo "Retrieved /$ssm_config_path/token_path parameter - ($token_path)"

# =============================================================================
# PHASE 5: X-Ray Daemon Setup (split download, unzip, start)
# =============================================================================
if [[ -n "$xray_trace_id" ]]; then
  echo "Setting up X-Ray daemon for tracing"

  # Download
  timed_exec "xray_download" curl -sf https://s3.us-east-2.amazonaws.com/aws-xray-assets.us-east-2/xray-daemon/aws-xray-daemon-linux-3.x.zip -o /tmp/aws-xray-daemon-linux-3.x.zip

  # Unzip
  UNZIP_START=$(date +%s.%N)
  unzip -q /tmp/aws-xray-daemon-linux-3.x.zip -d /tmp/aws-xray-daemon-linux-3.x
  chmod +x /tmp/aws-xray-daemon-linux-3.x/xray
  UNZIP_END=$(date +%s.%N)
  UNZIP_DURATION=$(echo "$UNZIP_END - $UNZIP_START" | bc)
  log_json "xray_unzip" "$UNZIP_DURATION" "ok"

  # Start daemon
  DAEMON_START=$(date +%s.%N)
  /tmp/aws-xray-daemon-linux-3.x/xray -o -n "$region" &
  sleep 1  # Give daemon time to start
  DAEMON_END=$(date +%s.%N)
  DAEMON_DURATION=$(echo "$DAEMON_END - $DAEMON_START" | bc)
  log_json "xray_daemon_start" "$DAEMON_DURATION" "ok"

  # Create X-Ray segment
  SEGMENT_DOC=$(create_xray_start_segment "$xray_trace_id" "$instance_id")
  echo "X-Ray segment created: $SEGMENT_DOC"
fi

# =============================================================================
# PHASE 6: CloudWatch Agent Start
# =============================================================================
if [[ "$enable_cloudwatch_agent" == "true" ]]; then
  echo "CloudWatch agent is enabled"
  timed_exec "cloudwatch_agent_start" amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c "ssm:$ssm_config_path/cloudwatch_agent_config_runner"
fi

# =============================================================================
# PHASE 7: SSM Config Polling (with poll count instrumentation)
# =============================================================================
SSM_POLL_START=$(date +%s.%N)
SSM_POLL_COUNT=0
SSM_POLL_MAX_WAIT=10

echo "Polling for GH Runner config from AWS SSM"
config=$(aws ssm get-parameter --name "$token_path"/"$instance_id" --with-decryption --region "$region" 2>/dev/null | jq -r ".Parameter | .Value" 2>/dev/null || echo "")

while [[ -z "$config" ]]; do
  SSM_POLL_COUNT=$((SSM_POLL_COUNT + 1))
  if [[ $SSM_POLL_COUNT -ge $SSM_POLL_MAX_WAIT ]]; then
    SSM_POLL_END=$(date +%s.%N)
    SSM_POLL_DURATION=$(echo "$SSM_POLL_END - $SSM_POLL_START" | bc)
    log_json "ssm_config_polling" "$SSM_POLL_DURATION" "error" "\"poll_count\":$SSM_POLL_COUNT,\"max_wait\":$SSM_POLL_MAX_WAIT"
    echo "ERROR: Timed out waiting for GH Runner config after $SSM_POLL_MAX_WAIT seconds"
    exit 1
  fi
  echo "Waiting for GH Runner config (attempt $SSM_POLL_COUNT/$SSM_POLL_MAX_WAIT)"
  sleep 1
  config=$(aws ssm get-parameter --name "$token_path"/"$instance_id" --with-decryption --region "$region" 2>/dev/null | jq -r ".Parameter | .Value" 2>/dev/null || echo "")
done

SSM_POLL_END=$(date +%s.%N)
SSM_POLL_DURATION=$(echo "$SSM_POLL_END - $SSM_POLL_START" | bc)
log_json "ssm_config_polling" "$SSM_POLL_DURATION" "ok" "\"poll_count\":$SSM_POLL_COUNT"
collect_metric "SSMPollingTime" "$SSM_POLL_DURATION"
collect_metric "SSMPollCount" "$SSM_POLL_COUNT"

echo "Delete GH Runner token from AWS SSM"
aws ssm delete-parameter --name "$token_path"/"$instance_id" --region "$region"

# =============================================================================
# PHASE 8: Runner Setup
# =============================================================================
if [[ -z "$run_as" ]]; then
  echo "No user specified, using default ec2-user account"
  run_as="ec2-user"
fi

if [[ "$run_as" == "root" ]]; then
  echo "run_as is set to root - export RUNNER_ALLOW_RUNASROOT=1"
  export RUNNER_ALLOW_RUNASROOT=1
fi

# Time chown separately - can be surprisingly slow
CHOWN_START=$(date +%s.%N)
chown -R "$run_as" /opt/actions-runner
CHOWN_END=$(date +%s.%N)
CHOWN_DURATION=$(echo "$CHOWN_END - $CHOWN_START" | bc)
log_json "chown_runner" "$CHOWN_DURATION" "ok"
collect_metric "ChownDuration" "$CHOWN_DURATION"

info_arch=$(uname -p)
info_os=$( ( lsb_release -ds || cat /etc/*release || uname -om ) 2>/dev/null | head -n1 | cut -d "=" -f2- | tr -d '"')

tee /opt/actions-runner/.setup_info <<EOL
[
  {
    "group": "Operating System",
    "detail": "Distribution: $info_os\nArchitecture: $info_arch"
  },
  {
    "group": "Runner Image",
    "detail": "AMI id: $ami_id"
  },
  {
    "group": "EC2",
    "detail": "Instance type: $instance_type\nAvailability zone: $availability_zone"
  }
]
EOL

# =============================================================================
# PHASE 9: Runner Configuration (if non-ephemeral or JIT disabled)
# =============================================================================
echo "Starting runner after $(awk '{print int($1/3600)":"int(($1%3600)/60)":"int($1%60)}' /proc/uptime)"
echo "Starting the runner as user $run_as"

if [[ "$enable_jit_config" == "false" || "$agent_mode" != "ephemeral" ]]; then
  echo "Configure GH Runner as user $run_as"

  extra_flags=""
  if [[ "$disable_default_labels" == "true" ]]; then
    extra_flags="--no-default-labels"
  fi

  CONFIG_START=$(date +%s.%N)
  sudo --preserve-env=RUNNER_ALLOW_RUNASROOT -u "$run_as" -- ./config.sh $${extra_flags} --unattended --name "$runner_name_prefix$instance_id" --work "_work" $${config}
  CONFIG_END=$(date +%s.%N)
  CONFIG_DURATION=$(echo "$CONFIG_END - $CONFIG_START" | bc)
  log_json "runner_config_sh" "$CONFIG_DURATION" "ok"
  collect_metric "RunnerConfigTime" "$CONFIG_DURATION"

  # Tag instance with GitHub runner agent ID
  tag_instance_with_runner_id
fi

# =============================================================================
# PHASE 10: Runner Start + Readiness Detection
# =============================================================================
RUNNER_START_TIME=$(date +%s.%N)

if [[ "$agent_mode" == "ephemeral" ]]; then
  echo "Starting the runner in ephemeral mode"

  if [[ "$enable_jit_config" == "true" ]]; then
    echo "Starting with JIT config"
    # For ephemeral: run in foreground, detect "Listening for Jobs" for readiness
    # Use process substitution to capture output while still running
    sudo --preserve-env=RUNNER_ALLOW_RUNASROOT -u "$run_as" -- ./run.sh --jitconfig $${config} 2>&1 | while IFS= read -r line; do
      echo "$line"
      if [[ "$line" == *"Listening for Jobs"* ]]; then
        READY_TIME=$(date +%s.%N)
        READY_DURATION=$(echo "$READY_TIME - $RUNNER_START_TIME" | bc)
        BOOT_TO_READY=$(echo "$READY_TIME - $BOOT_START_TIME" | bc)
        log_json "runner_ready" "$READY_DURATION" "ok" "\"boot_to_ready_s\":$BOOT_TO_READY"
        collect_metric "BootToReadyTime" "$BOOT_TO_READY"
        # End X-Ray segment now that runner is ready
        create_xray_success_segment
        # Emit all collected metrics
        emit_all_metrics
      fi
    done
  else
    echo "Starting without JIT config"
    sudo --preserve-env=RUNNER_ALLOW_RUNASROOT -u "$run_as" -- ./run.sh 2>&1 | while IFS= read -r line; do
      echo "$line"
      if [[ "$line" == *"Listening for Jobs"* ]]; then
        READY_TIME=$(date +%s.%N)
        READY_DURATION=$(echo "$READY_TIME - $RUNNER_START_TIME" | bc)
        BOOT_TO_READY=$(echo "$READY_TIME - $BOOT_START_TIME" | bc)
        log_json "runner_ready" "$READY_DURATION" "ok" "\"boot_to_ready_s\":$BOOT_TO_READY"
        collect_metric "BootToReadyTime" "$BOOT_TO_READY"
        create_xray_success_segment
        emit_all_metrics
      fi
    done
  fi
  echo "Runner has finished"
else
  echo "Installing the runner as a service"
  ./svc.sh install "$run_as"
  echo "Starting the runner in persistent mode"
  ./svc.sh start

  # Wait for service to become active
  READY_TIMEOUT=60
  READY_ELAPSED=0
  while [[ $READY_ELAPSED -lt $READY_TIMEOUT ]]; do
    if systemctl is-active --quiet "actions.runner.*.service" 2>/dev/null; then
      READY_TIME=$(date +%s.%N)
      READY_DURATION=$(echo "$READY_TIME - $RUNNER_START_TIME" | bc)
      BOOT_TO_READY=$(echo "$READY_TIME - $BOOT_START_TIME" | bc)
      log_json "runner_ready" "$READY_DURATION" "ok" "\"boot_to_ready_s\":$BOOT_TO_READY,\"mode\":\"service\""
      collect_metric "BootToReadyTime" "$BOOT_TO_READY"
      break
    fi
    sleep 1
    READY_ELAPSED=$((READY_ELAPSED + 1))
  done

  # End X-Ray segment and emit metrics
  create_xray_success_segment
  emit_all_metrics
fi

# Log total boot time
TOTAL_BOOT_END=$(date +%s.%N)
TOTAL_BOOT_TIME=$(echo "$TOTAL_BOOT_END - $BOOT_START_TIME" | bc)
log_json "total_boot_time" "$TOTAL_BOOT_TIME" "ok"
echo "Runner boot completed in $TOTAL_BOOT_TIME seconds"
