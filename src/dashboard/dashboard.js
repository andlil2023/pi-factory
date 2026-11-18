'use strict';
const $ = id => document.getElementById(id);
let selected = null;
let stream = null;
let generation = 0;
let loading = false;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}
function age(timestamp) {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return 'time unavailable';
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
function label(value) { return String(value ?? 'unknown').replaceAll('_', ' ').toLowerCase(); }
function badge(value, text) {
  const element = node('span', text || label(value), 'badge');
  element.dataset.tone = ['completed', 'approved', 'passed', 'implemented'].includes(value) ? 'good'
    : ['blocked', 'failed', 'error', 'changes_requested'].includes(value) ? 'bad'
    : ['running', 'needs_review'].includes(value) ? 'active'
    : ['paused', 'repair_pending', 'interrupted'].includes(value) ? 'warn' : 'neutral';
  return element;
}
function verificationProgress(parent, value) {
  if (!value) return;
  parent.append(node('p', `Verification commands: ${value.completed}/${value.total} finished · ${value.mode} suite · ${value.failed} failed`, 'task-meta'));
}
function deliveryLabel(run) {
  const status = run.deliveryStatus;
  return ({ awaiting_integration: 'Work verified · awaiting integration', integrated: 'Integrated into target', pr_opened: 'PR opened · awaiting merge' })[status]
    || (status?.startsWith('integration_') ? `Integration: ${label(status.slice(12))}` : label(run.status));
}
function verification(value, title) {
  return badge(value ? (value.passed ? 'passed' : 'failed') : 'pending', `${title}: ${value ? (value.passed ? 'passed' : 'failed') : 'not checked'}`);
}
function issue(parent, title, description, action) {
  const box = node('div', undefined, 'issue');
  if (title) box.append(node('strong', title));
  if (description) box.append(node('p', description));
  if (action) box.append(node('p', action));
  parent.append(box);
}
function reviews(parent, items) {
  for (const review of items || []) {
    parent.append(badge(review.verdict, `${review.reviewer || 'Reviewer'}: ${label(review.verdict)}`));
    for (const finding of review.findings || []) {
      const location = finding.file ? `${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''}` : '';
      issue(parent, [finding.severity, location].filter(Boolean).join(' · '), finding.description, finding.requiredAction);
      if (finding.evidence) parent.append(node('p', finding.evidence, 'task-meta'));
    }
  }
}
function disclosure(title, key, openKeys) {
  const element = node('details');
  element.dataset.key = key;
  element.open = openKeys.has(key);
  element.append(node('summary', title));
  return element;
}
function renderTask(task, maxAttempts, openKeys, key = task.id) {
  const card = node('article', undefined, 'task-card');
  const heading = node('div', undefined, 'task-heading');
  const name = node('div', undefined, 'task-name');
  name.append(node('h3', task.title || task.id), node('p', task.id, 'display-id'));
  heading.append(name, badge(task.status, task.status === 'completed' ? 'Accepted on run branch' : label(task.status)));
  card.append(heading);
  const attempts = task.attempts || [];
  const latest = attempts[attempts.length - 1];
  card.append(node('p', `${task.budgetUsed ?? attempts.length}${maxAttempts !== undefined ? ` / ${maxAttempts}` : ''} attempts used${latest ? ` · Last activity ${age(latest.finishedAt || latest.startedAt)}` : ' · Not started'}`, 'task-meta'));
  if (latest?.phase && !latest.finishedAt && latest.phase !== 'finished') card.append(node('p', `Current phase: ${label(latest.phase)}`, 'task-meta'));
  verificationProgress(card, latest?.verificationProgress);
  if (latest) {
    const checks = node('div', undefined, 'checks');
    checks.append(verification(latest.verification, 'Verification'));
    for (const review of latest.reviews || []) checks.append(badge(review.verdict, `${review.reviewer}: ${label(review.verdict)}`));
    card.append(checks);
  }
  if (task.lastError) issue(card, 'Needs attention', task.lastError);
  if (latest) {
    for (const blocker of latest.blockers || []) issue(card, blocker.kind || 'Blocker', blocker.description, blocker.question);
    for (const review of latest.reviews || []) {
      for (const finding of review.findings || []) {
        issue(card, `${finding.severity || 'Finding'}${finding.file ? ` · ${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''}` : ''}`, finding.description, finding.requiredAction);
      }
    }
  }
  if (attempts.length) {
    const history = disclosure(`Attempt history (${attempts.length})`, `task:${key}`, openKeys);
    for (const attempt of [...attempts].reverse()) {
      const row = node('div', undefined, 'attempt');
      row.append(node('h3', `Attempt ${attempt.number}`));
      row.append(node('p', `${attempt.startedAt}${attempt.finishedAt ? ` → ${attempt.finishedAt}` : ' · In progress'}`, 'task-meta'));
      const checks = node('div', undefined, 'checks');
      checks.append(badge(attempt.outcome || 'running'), verification(attempt.verification, 'Verification'));
      if (attempt.flakyCount > 0) checks.append(node('span', `Passed on rerun: ${attempt.flakyCount}`, 'task-meta'));
      row.append(checks);
      for (const blocker of attempt.blockers || []) {
        issue(row, blocker.kind || 'Blocker', blocker.description, blocker.question);
        if (blocker.proposedSplit?.length) row.append(node('p', `Proposed split: ${blocker.proposedSplit.join(' · ')}`, 'task-meta'));
      }
      reviews(row, attempt.reviews);
      history.append(row);
    }
    card.append(history);
  }
  return card;
}
async function refresh() {
  if (loading) return;
  loading = true;
  const currentGeneration = generation;
  try {
    const response = await fetch('/api/runs');
    if (!response.ok) throw new Error('Request failed');
    const runs = await response.json();
    runs.sort((a, b) => (Date.parse(b.run?.updatedAt) || 0) - (Date.parse(a.run?.updatedAt) || 0));
    const list = $('runs');
    const focused = document.activeElement;
    const focusedRun = list.contains(focused) ? focused.dataset.runId : undefined;
    list.replaceChildren();
    let focusTarget = null;
    $('list-status').textContent = runs.length ? `${runs.length} runs · newest activity first` : 'No runs found. Start a factory run to see it here.';
    for (const entry of runs) {
      const li = node('li');
      const button = node('button', undefined, 'run-button'); button.type = 'button';
      button.dataset.runId = entry.runId;
      button.setAttribute('aria-pressed', String(selected === entry.runId));
      button.append(node('span', entry.available && entry.run?.label || entry.runId, 'run-name'), node('span', entry.runId, 'display-id'));
      const meta = node('span', undefined, 'run-meta');
      meta.append(badge(entry.available ? entry.run.status : 'unavailable', entry.available ? deliveryLabel(entry.run) : 'Unavailable'), node('span', entry.available ? age(entry.run.updatedAt) : 'Cannot read state'));
      button.append(meta);
      if (focusedRun !== undefined && focusedRun === entry.runId) focusTarget = button;
      button.addEventListener('click', () => selectRun(entry.runId));
      li.append(button); list.append(li);
    }
    if (focusedRun !== undefined) (focusTarget || $('refresh')).focus();
    if (currentGeneration === generation && selected) {
      showDetails(runs.find(item => item.runId === selected) || { runId: selected, available: false });
    }
  } catch {
    $('list-status').textContent = 'Error loading runs. Retry with Refresh now.';
  } finally { loading = false; }
}
function showDetails(entry) {
  const details = $('details');
  const openKeys = new Set(Array.from(details.querySelectorAll('details[open]'), item => item.dataset.key));
  const focusedDisclosure = Array.from(details.querySelectorAll('details')).find(item => item.firstElementChild === document.activeElement);
  const focusedKey = focusedDisclosure?.dataset.key;
  const restoreDisclosureFocus = () => {
    if (focusedKey === undefined) return;
    const target = Array.from(details.querySelectorAll('details')).find(item => item.dataset.key === focusedKey);
    (target?.firstElementChild || $('refresh')).focus();
  };
  details.replaceChildren();
  $('detail-heading').textContent = entry.available && entry.run?.label || entry.runId;
  details.append(node('p', entry.runId, 'display-id'));
  if (!entry.available) {
    $('detail-status').textContent = 'Run unavailable';
    details.append(node('div', 'This run’s persisted state is missing or unreadable. Try refreshing.', 'empty-state'));
    restoreDisclosureFocus();
    return;
  }
  const run = entry.run;
  const tasks = run.tasks || [];
  const completed = tasks.filter(task => task.status === 'completed').length;
  const active = tasks.filter(task => ['running', 'needs_review', 'repair_pending'].includes(task.status)).length;
  const blocked = tasks.filter(task => task.status === 'blocked' || task.lastError || task.attempts?.at(-1)?.blockers?.length).length;
  $('detail-status').textContent = `Last persisted state · updated ${age(run.updatedAt)} · ${run.updatedAt}`;
  if (run.objectiveSummary) {
    details.append(node('h3', 'Intended work', 'subheading'), node('p', run.objectiveSummary, 'objective-summary'));
  }
  details.append(badge(run.status, deliveryLabel(run)));
  details.append(node('p', 'Task acceptance is on the isolated run branch. Integration and publication are separate approved steps; an open PR is not a merge.', 'task-meta'));
  const stats = node('div', undefined, 'stats');
  for (const [value, title] of [[`${completed}/${tasks.length}`, 'Tasks accepted'], [active, 'Active / in review'], [blocked, 'Need attention'], [tasks.reduce((sum, task) => sum + (task.budgetUsed || 0), 0), 'Attempts used']]) {
    const stat = node('div', undefined, 'stat');
    stat.append(node('span', value, 'stat-value'), node('span', title, 'stat-label')); stats.append(stat);
  }
  details.append(stats);
  const progress = node('div', undefined, 'progress');
  const fill = node('div', undefined, 'progress-fill');
  const percent = tasks.length ? Math.round(completed / tasks.length * 100) : 0;
  fill.style.width = `${percent}%`; progress.append(fill); details.append(progress);
  details.append(node('p', `${percent}% of tasks accepted · Created ${run.createdAt}`, 'task-meta'));
  const checks = node('div', undefined, 'checks');
  checks.append(verification(run.finalVerification, 'Final verification'));
  verificationProgress(checks, run.finalVerificationProgress);
  if (run.finalVerification?.checkedAt) checks.append(node('span', run.finalVerification.checkedAt, 'task-meta'));
  details.append(checks);
  if (run.autoReplans?.length) {
    const revisions = disclosure(`Automatic plan revisions (${run.autoReplans.length})`, 'revisions', openKeys);
    for (const revision of run.autoReplans) {
      const row = node('div', undefined, 'attempt');
      const reason = revision.reason === 'budget_exhausted' ? 'Repair budget exhausted' : 'Task too large';
      row.append(node('p', `Time: ${revision.at}`), node('p', `Stopped task: ${revision.taskId}`),
        node('p', `Reason: ${reason}`), node('p', `Superseded: ${revision.superseded.join(' · ')}`),
        node('p', `Added: ${revision.added.join(' · ')}`));
      if (revision.hasLeftoverPatch) row.append(node('p', 'Leftover patch saved.', 'task-meta'));
      revisions.append(row);
    }
    details.append(revisions);
  }
  details.append(node('h3', 'Tasks', 'subheading'));
  const list = node('div', undefined, 'task-list');
  // Keep failures and current work above completed tasks without hiding any tasks.
  const rank = { blocked: 0, running: 1, needs_review: 2, repair_pending: 3, pending: 4, completed: 5 };
  for (const task of [...tasks].sort((a, b) => rank[a.status] - rank[b.status])) list.append(renderTask(task, run.maxAttempts, openKeys));
  if (!tasks.length) list.append(node('p', 'No tasks have been recorded yet.', 'muted'));
  details.append(list);
  if (run.integrations?.length) {
    details.append(node('h3', 'Integration checks', 'subheading'));
    for (const integration of run.integrations) {
      const card = node('article', undefined, 'task-card');
      card.append(node('h3', `Integration ${integration.number ?? '—'}`), badge(integration.status));
      if (integration.phase) card.append(node('p', `Phase: ${label(integration.phase)}${integration.phaseUpdatedAt ? ` · ${age(integration.phaseUpdatedAt)}` : ''}`, 'task-meta'));
      verificationProgress(card, integration.verificationProgress);
      for (const id of integration.requiredReviewers || []) {
        if (!(integration.reviews || []).some(review => review.reviewer === id)) card.append(badge('pending', `${id}: pending`));
      }
      const checks = node('div', undefined, 'checks');
      checks.append(verification(integration.verification, 'Verification'), verification(integration.publicationVerification, 'Publication verification'));
      card.append(checks);
      if (integration.error) issue(card, 'Integration error', integration.error);
      reviews(card, integration.reviews); details.append(card);
    }
  }
  if (run.supersededTasks?.length) {
    const archived = disclosure(`Superseded tasks (${run.supersededTasks.length})`, 'superseded', openKeys);
    for (const [index, entry] of run.supersededTasks.entries()) {
      archived.append(node('p', `Superseded ${entry.supersededAt}`, 'task-meta'), renderTask(entry.task, run.maxAttempts, openKeys, `archived:${index}`));
    }
    details.append(archived);
  }
  restoreDisclosureFocus();
}
function selectRun(id) {
  selected = id; generation++;
  for (const button of $('runs').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.runId === id));
  if (stream) stream.close();
  $('details').replaceChildren(); $('timeline').replaceChildren();
  $('detail-heading').textContent = id;
  $('detail-status').textContent = 'Loading run details…';
  $('connection').textContent = 'Connecting to live updates…';
  const current = generation;
  fetch(`/api/runs/${encodeURIComponent(id)}`).then(response => {
    if (!response.ok) throw new Error('Request failed');
    return response.json();
  }).then(entry => { if (current === generation) showDetails(entry); })
    .catch(() => { if (current === generation) $('detail-status').textContent = 'Error loading run details. Retry with Refresh now.'; });
  const connection = new EventSource(`/api/runs/${encodeURIComponent(id)}/live`);
  stream = connection;
  connection.onopen = () => { if (current === generation) $('connection').textContent = 'Live connection · Events are observational'; };
  connection.onerror = () => { if (current === generation) $('connection').textContent = 'Disconnected · Reconnecting automatically'; };
  connection.addEventListener('snapshot', event => {
    if (current !== generation) return;
    try {
      const events = JSON.parse(event.data);
      const timeline = $('timeline');
      // SSE snapshots replace the timeline, including after reconnect.
      timeline.replaceChildren();
      for (const item of [...events].reverse()) {
        const li = node('li', undefined, 'event');
        const heading = node('div', undefined, 'event-heading');
        const time = node('time', age(item.timestamp)); time.dateTime = item.timestamp; time.title = item.timestamp;
        heading.append(node('strong', label(item.type)), time); li.append(heading);
        const context = [item.taskId, item.agent, item.attempt !== undefined ? `Attempt ${item.attempt}` : null].filter(Boolean);
        if (context.length) li.append(node('p', context.join(' · ')));
        if (item.message) li.append(node('p', item.message));
        timeline.append(li);
      }
      if (!events.length) timeline.append(node('li', 'No lifecycle events yet.', 'muted'));
    } catch { $('connection').textContent = 'Error reading lifecycle events.'; }
  });
}
$('refresh').addEventListener('click', refresh);
refresh();
setInterval(refresh, 5000);
