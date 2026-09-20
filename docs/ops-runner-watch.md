# Ops runner watch

This repository hosts the independent cross-organization GitHub Actions watchdog.

## Why this lives here

The project repositories primarily use self-hosted runners. A monitor running on the same self-hosted pool cannot report a total pool outage, so this workflow intentionally runs on GitHub-hosted `ubuntu-latest` in the public American Trailmarks `.github` repository.

The pull-request validation job also runs on `ubuntu-latest`, which gives us direct evidence that GitHub-hosted execution is available before the watchdog is merged.

## Alert policy

The watchdog runs every 15 minutes and stays silent when healthy. It posts to Slack `#ops` only when shared automation needs attention:

- a visible self-hosted runner is offline;
- a workflow is queued, pending, requested, or waiting for more than 15 minutes;
- the monitor cannot read runner or workflow state for one of its configured repositories.

Project-specific workflow failures remain the responsibility of each project's Slack notifier and should not be duplicated in `#ops`.

Repeated checks with the same problem fingerprint are deduplicated. A changed problem set generates a new alert.

## Required repository secrets

Configure these repository-level Actions secrets on `American-Trailmarks/.github`:

- `SLACK_WEBHOOK_URL`: the incoming webhook for Slack `#ops`.
- `OPS_MONITOR_GITHUB_TOKEN`: a dedicated token able to read Actions runs and self-hosted-runner state for every monitored private repository.
- `OPS_MONITOR_REPOSITORIES`: comma-separated `owner/repo` names to monitor.

Do not place any token, webhook URL, or private repository list in this public repository.

## Validation and rollout

1. Merge only after the PR's GitHub-hosted validation job is green.
2. Configure all three repository secrets.
3. Run `Ops / Runner watch` manually once.
4. Confirm a healthy run stays silent.
5. After the GitHub-hosted watchdog is proven, remove any temporary external watchdog that duplicates this responsibility.
