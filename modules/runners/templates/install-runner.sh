# shellcheck shell=bash

# =============================================================================
# Install Runner Script with Timing Instrumentation
# =============================================================================
# All timing data is output as single-line JSON for CloudWatch Logs Insights
# Format: {"ts":"...", "phase":"...", "duration_s":1.23, "status":"ok|error", ...}
# =============================================================================

INSTALL_START_TIME=$(date +%s.%N)

# -----------------------------------------------------------------------------
# log_json - Output a JSON log line with timing data
# -----------------------------------------------------------------------------
log_json() {
  local phase="$1"
  local duration="$2"
  local status="${3:-ok}"
  local extra="${4:-}"

  local base
  base=$(printf '{"ts":"%s","phase":"%s","duration_s":%s,"status":"%s"' \
    "$(date -Iseconds)" "$phase" "$duration" "$status")

  if [[ -n "$extra" ]]; then
    echo "${base},${extra}}"
  else
    echo "${base}}"
  fi
}

# -----------------------------------------------------------------------------
# timed_exec - Execute a command and log its timing
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

  log_json "$phase" "$duration" "$status" "\"exit_code\":$exit_code" >&2
  echo "$output"
  return $exit_code
}

# -----------------------------------------------------------------------------
# timed_retry - Execute a command with retries and log timing + retry stats
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

    [[ $exit_code -eq 0 ]] && break

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

  echo "$output"
  return $exit_code
}

# =============================================================================
# Configuration
# =============================================================================
s3_location=${S3_LOCATION_RUNNER_DISTRIBUTION}
architecture=${RUNNER_ARCHITECTURE}

if [ -z "$RUNNER_TARBALL_URL" ] && [ -z "$s3_location" ]; then
  echo "Neither RUNNER_TARBALL_URL or s3_location are set"
  exit 1
fi

file_name="actions-runner.tar.gz"

echo "Setting up GH Actions runner tool cache"
mkdir -p /opt/hostedtoolcache

echo "Creating actions-runner directory for the GH Action installation"
cd /opt/
mkdir -p actions-runner && cd actions-runner

# =============================================================================
# PHASE 1: Runner Download
# =============================================================================
if [[ -n "$RUNNER_TARBALL_URL" ]]; then
  echo "Downloading the GH Action runner from $RUNNER_TARBALL_URL to $file_name"
  timed_exec "runner_download_url" curl -sf -o $file_name -L "$RUNNER_TARBALL_URL"
else
  # Get IMDS token first
  echo "Retrieving IMDSv2 token from AWS API"
  token=$(timed_retry "imds_token" 5 2 curl -sf -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 180")

  if [[ -z "$token" ]]; then
    echo "FATAL: Failed to retrieve IMDS token"
    exit 1
  fi

  region=$(timed_exec "metadata_region" curl -sf -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/dynamic/instance-identity/document)
  region=$(echo "$region" | jq -r .region)
  echo "Retrieved REGION from AWS API ($region)"

  echo "Downloading the GH Action runner from s3 bucket $s3_location"
  DOWNLOAD_START=$(date +%s.%N)
  aws s3 cp "$s3_location" "$file_name" --region "$region" --no-progress
  DOWNLOAD_EXIT=$?
  DOWNLOAD_END=$(date +%s.%N)
  DOWNLOAD_DURATION=$(echo "$DOWNLOAD_END - $DOWNLOAD_START" | bc)

  # Get file size for logging
  file_size=0
  [[ -f "$file_name" ]] && file_size=$(stat -f%z "$file_name" 2>/dev/null || stat -c%s "$file_name" 2>/dev/null || echo 0)

  download_status="ok"
  [[ $DOWNLOAD_EXIT -ne 0 ]] && download_status="error"
  log_json "runner_download_s3" "$DOWNLOAD_DURATION" "$download_status" "\"exit_code\":$DOWNLOAD_EXIT,\"file_size_bytes\":$file_size"
fi

# =============================================================================
# PHASE 2: Runner Extraction
# =============================================================================
EXTRACT_START=$(date +%s.%N)
echo "Un-tar action runner"
tar xzf ./$file_name
TAR_EXIT=$?
echo "Delete tar file"
rm -rf $file_name
EXTRACT_END=$(date +%s.%N)
EXTRACT_DURATION=$(echo "$EXTRACT_END - $EXTRACT_START" | bc)

status="ok"
[[ $TAR_EXIT -ne 0 ]] && status="error"
log_json "runner_extraction" "$EXTRACT_DURATION" "$status" "\"exit_code\":$TAR_EXIT"

os_id=$(awk -F= '/^ID=/{print $2}' /etc/os-release)
echo "OS: $os_id"

# =============================================================================
# PHASE 3: Dependencies Installation (with retry count)
# =============================================================================
if [[ ! "$os_id" =~ ^ubuntu.* ]]; then
  DEPS_START=$(date +%s.%N)
  max_attempts=5
  attempt_count=0
  success=false

  while [[ $success == false && $attempt_count -le $max_attempts ]]; do
    echo "Attempt $((attempt_count + 1))/$max_attempts: Installing libicu"
    if dnf install -y libicu 2>&1; then
      success=true
    else
      echo "Failed to install libicu"
      attempt_count=$((attempt_count + 1))
      [[ $attempt_count -lt $max_attempts ]] && sleep 5
    fi
  done

  DEPS_END=$(date +%s.%N)
  DEPS_DURATION=$(echo "$DEPS_END - $DEPS_START" | bc)
  status="ok"
  [[ $success != true ]] && status="error"
  log_json "dependencies_install_dnf" "$DEPS_DURATION" "$status" "\"attempts\":$((attempt_count + 1)),\"max_attempts\":$max_attempts"
fi

# Install dependencies for ubuntu
if [[ "$os_id" =~ ^ubuntu.* ]]; then
  echo "Installing dependencies"
  timed_exec "dependencies_install_ubuntu" ./bin/installdependencies.sh
fi

# =============================================================================
# PHASE 4: Set File Ownership (can be surprisingly slow)
# =============================================================================
CHOWN_START=$(date +%s.%N)
echo "Set file ownership of action runner"
chown -R "$user_name":"$user_name" /opt/actions-runner
chown -R "$user_name":"$user_name" /opt/hostedtoolcache
CHOWN_END=$(date +%s.%N)
CHOWN_DURATION=$(echo "$CHOWN_END - $CHOWN_START" | bc)
log_json "chown_runner_install" "$CHOWN_DURATION" "ok"

# =============================================================================
# Log Total Install Time
# =============================================================================
INSTALL_END_TIME=$(date +%s.%N)
TOTAL_INSTALL_TIME=$(echo "$INSTALL_END_TIME - $INSTALL_START_TIME" | bc)
log_json "total_install_time" "$TOTAL_INSTALL_TIME" "ok"
echo "Runner installation completed in $TOTAL_INSTALL_TIME seconds"
