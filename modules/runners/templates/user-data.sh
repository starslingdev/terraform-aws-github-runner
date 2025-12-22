#!/bin/bash -e

# User-data timing instrumentation
USERDATA_START_TIME=$(date +%s.%N)

get_elapsed_time() {
  local start_time=$1
  local end_time=$(date +%s.%N)
  echo "$end_time - $start_time" | bc
}

log_userdata_timing() {
  local phase=$1
  local duration=$2
  echo "USERDATA_TIMING: phase=$phase duration_seconds=$duration"
}

install_with_retry() {
  max_attempts=5
  attempt_count=0
  success=false
  while [ $success = false ] && [ $attempt_count -le $max_attempts ]; do
    echo "Attempting $attempt_count/$max_attempts: Installing $*"
    dnf install -y $*
  if [ $? -eq 0 ]; then
      success=true
    else
      echo "Failed to install $1 - retrying"
      attempt_count=$(( attempt_count + 1 ))
      sleep 5
    fi
  done
}

exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

# AWS suggest to create a log for debug purpose based on https://aws.amazon.com/premiumsupport/knowledge-center/ec2-linux-log-user-data/
# As side effect all command, set +x disable debugging explicitly.
#
# An alternative for masking tokens could be: exec > >(sed 's/--token\ [^ ]* /--token\ *** /g' > /var/log/user-data.log) 2>&1

set +x

%{ if enable_debug_logging }
set -x
%{ endif }

${pre_install}

# Phase: System updates (dnf upgrade-minimal)
PHASE_START=$(date +%s.%N)
max_attempts=5
attempt_count=0
success=false
while [ $success = false ] && [ $attempt_count -le $max_attempts ]; do
  echo "Attempting $attempt_count/$max_attempts: upgrade-minimal"
  dnf upgrade-minimal -y
if [ $? -eq 0 ]; then
    success=true
  else
    echo "Failed to run `dnf upgrad-minimal -y` - retrying"
    attempt_count=$(( attempt_count + 1 ))
    sleep 5
  fi
done
log_userdata_timing "dnf_upgrade_minimal" "$(get_elapsed_time "$PHASE_START")"

# Phase: Docker installation
PHASE_START=$(date +%s.%N)
install_with_retry docker
service docker start
usermod -a -G docker ec2-user
log_userdata_timing "docker_install" "$(get_elapsed_time "$PHASE_START")"

# Phase: Package installations (cloudwatch-agent, jq, git, curl)
PHASE_START=$(date +%s.%N)
install_with_retry amazon-cloudwatch-agent jq git
install_with_retry --allowerasing curl
log_userdata_timing "packages_install" "$(get_elapsed_time "$PHASE_START")"

user_name=ec2-user

# Phase: Runner installation
PHASE_START=$(date +%s.%N)
${install_runner}
log_userdata_timing "runner_install" "$(get_elapsed_time "$PHASE_START")"

# Phase: Post-install hooks
PHASE_START=$(date +%s.%N)
${post_install}
log_userdata_timing "post_install" "$(get_elapsed_time "$PHASE_START")"

# Register runner job hooks
# Ref: https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/running-scripts-before-or-after-a-job
%{ if hook_job_started != "" }
cat > /opt/actions-runner/hook_job_started.sh <<'EOF'
${hook_job_started}
EOF
echo ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/actions-runner/hook_job_started.sh | tee -a /opt/actions-runner/.env
%{ endif }

%{ if hook_job_completed != "" }
cat > /opt/actions-runner/hook_job_completed.sh <<'EOF'
${hook_job_completed}
EOF
echo ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/opt/actions-runner/hook_job_completed.sh | tee -a /opt/actions-runner/.env
%{ endif }

# Log total user-data time before starting runner
TOTAL_USERDATA_TIME=$(get_elapsed_time "$USERDATA_START_TIME")
log_userdata_timing "total_userdata_time" "$TOTAL_USERDATA_TIME"
echo "User-data script completed in $TOTAL_USERDATA_TIME seconds"

${start_runner}
