import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const token = process.env.OPS_MONITOR_GITHUB_TOKEN?.trim();
const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
const repositories = (process.env.OPS_MONITOR_REPOSITORIES || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const thresholdMinutes = Number(process.env.OPS_QUEUE_THRESHOLD_MINUTES || "15");
const statePath = process.env.OPS_MONITOR_STATE_PATH || ".state/ops-runner-watch.hash";

if (!token) throw new Error("OPS_MONITOR_GITHUB_TOKEN is required.");
if (!webhook) throw new Error("SLACK_WEBHOOK_URL is required.");
if (!repositories.length) throw new Error("OPS_MONITOR_REPOSITORIES must contain at least one owner/repo entry.");

const github = async (path) => {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "cross-org-ops-runner-watch",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${path}: ${await response.text()}`);
  }
  return response.json();
};

const ageMinutes = (timestamp) => (Date.now() - Date.parse(timestamp)) / 60000;
const problems = [];
const runnerProblems = new Map();

for (const repository of repositories) {
  const encodedRepo = repository.split("/").map(encodeURIComponent).join("/");
  try {
    const runners = await github(`/repos/${encodedRepo}/actions/runners?per_page=100`);
    for (const runner of runners.runners || []) {
      if (runner.status === "offline") {
        const key = runner.name || `runner-${runner.id}`;
        if (!runnerProblems.has(key)) runnerProblems.set(key, []);
        runnerProblems.get(key).push(repository);
      }
    }
  } catch (error) {
    problems.push({
      kind: "monitor-access",
      repository,
      summary: "Runner health could not be inspected",
      detail: String(error.message || error).slice(0, 240),
      url: `https://github.com/${repository}/actions`,
    });
  }

  try {
    const payload = await github(`/repos/${encodedRepo}/actions/runs?per_page=100`);
    for (const run of payload.workflow_runs || []) {
      if (!["queued", "waiting", "requested", "pending"].includes(run.status)) continue;
      const age = ageMinutes(run.created_at);
      if (age < thresholdMinutes) continue;
      problems.push({
        kind: run.status === "waiting" ? "approval-wait" : "queue",
        repository,
        summary: `${run.name} has been ${run.status} for ${Math.floor(age)}m`,
        detail: `event=${run.event}; branch=${run.head_branch || "unknown"}`,
        url: run.html_url,
      });
    }
  } catch (error) {
    problems.push({
      kind: "monitor-access",
      repository,
      summary: "Workflow health could not be inspected",
      detail: String(error.message || error).slice(0, 240),
      url: `https://github.com/${repository}/actions`,
    });
  }
}

for (const [runner, repos] of runnerProblems) {
  problems.push({
    kind: "runner-offline",
    repository: repos.join(", "),
    summary: `Self-hosted runner ${runner} is offline`,
    detail: `Visible to ${repos.length} monitored repositor${repos.length === 1 ? "y" : "ies"}`,
    url: "https://github.com/organizations/American-Trailmarks/settings/actions/runners",
  });
}

problems.sort((a, b) =>
  [a.kind, a.repository, a.summary, a.detail].join("|").localeCompare(
    [b.kind, b.repository, b.summary, b.detail].join("|"),
  ),
);

const fingerprint = createHash("sha256")
  .update(JSON.stringify(problems.map(({ kind, repository, summary, detail }) => ({ kind, repository, summary, detail }))))
  .digest("hex");

let previous = "";
try {
  previous = (await readFile(statePath, "utf8")).trim();
} catch {}

await writeFile(statePath, problems.length ? fingerprint : "healthy", "utf8");

if (!problems.length) {
  console.log("Ops runner watch: healthy.");
  process.exit(0);
}

if (previous === fingerprint) {
  console.log(`Ops runner watch: ${problems.length} existing problem(s); alert already sent for this state.`);
  process.exit(0);
}

const lines = [
  ":rotating_light: *Shared GitHub automation needs attention*",
  `*Problems:* ${problems.length}`,
  "",
  ...problems.slice(0, 10).flatMap((problem) => [
    `• *${problem.summary}*`,
    `  ${problem.repository} — ${problem.detail}`,
    `  <${problem.url}|Open GitHub>`,
  ]),
];
if (problems.length > 10) lines.push(`…and ${problems.length - 10} more.`);

const response = await fetch(webhook, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: lines.join("\n") }),
});
if (!response.ok) {
  throw new Error(`Slack webhook failed (${response.status}): ${await response.text()}`);
}
console.log(`Ops runner watch: alerted on ${problems.length} new/changed problem(s).`);
