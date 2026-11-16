'use strict';
const $ = id => document.getElementById(id);
let selected = null;
let stream = null;
let generation = 0;
let loading = false;

function node(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function age(timestamp) {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return 'age unavailable';
  return `${Math.max(0, Math.floor((Date.now() - time) / 1000))}s ago`;
}
function status(run) {
  return run.status === 'running'
    ? `running — last persisted state, updated ${age(run.updatedAt)} (${run.updatedAt})`
    : `${run.status} — persisted ${age(run.updatedAt)} (${run.updatedAt})`;
}
// Render the complete allowlisted projection without interpreting any file value as markup.
function renderValue(parent, value) {
  if (value === null || value === undefined) { parent.append(node('span', 'Not available')); return; }
  if (Array.isArray(value)) {
    if (!value.length) { parent.append(node('span', 'None')); return; }
    const list = node('ul');
    for (const item of value) { const li = node('li'); renderValue(li, item); list.append(li); }
    parent.append(list); return;
  }
  if (typeof value === 'object') {
    const list = node('dl');
    for (const [key, item] of Object.entries(value)) {
      list.append(node('dt', key));
      const dd = node('dd'); renderValue(dd, item); list.append(dd);
    }
    parent.append(list); return;
  }
  parent.append(node('span', value));
}
async function refresh() {
  if (loading) return;
  loading = true;
  const currentGeneration = generation;
  try {
    const response = await fetch('/api/runs');
    if (!response.ok) throw new Error('Request failed');
    const runs = await response.json();
    const list = $('runs');
    // Capture focus immediately before rebuilding, not before the asynchronous fetch.
    const focused = document.activeElement;
    const focusedRun = list.contains(focused) ? focused.dataset.runId : undefined;
    list.replaceChildren();
    let focusTarget = null;
    $('list-status').textContent = runs.length ? `${runs.length} run(s).` : 'No runs found.';
    for (const entry of runs) {
      const li = node('li');
      const button = node('button', entry.runId); button.type = 'button';
      button.dataset.runId = entry.runId;
      if (focusedRun !== undefined && focusedRun === entry.runId) focusTarget = button;
      button.addEventListener('click', () => selectRun(entry.runId));
      li.append(button, node('span', ` — ${entry.available ? status(entry.run) : 'unavailable'}`));
      list.append(li);
    }
    if (focusedRun !== undefined) (focusTarget || $('refresh')).focus();
    if (currentGeneration === generation && selected) {
      const entry = runs.find(item => item.runId === selected);
      showDetails(entry || { runId: selected, available: false });
    }
  } catch {
    $('list-status').textContent = 'Error loading runs. Retry with Refresh now.';
  } finally { loading = false; }
}
function showDetails(entry) {
  const details = $('details'); details.replaceChildren();
  if (!entry.available) { $('detail-status').textContent = `${entry.runId}: unavailable`; return; }
  $('detail-status').textContent = `${entry.runId}: ${status(entry.run)}`;
  renderValue(details, entry.run);
}
function selectRun(id) {
  selected = id; generation++;
  if (stream) stream.close();
  $('details').replaceChildren(); $('timeline').replaceChildren();
  $('detail-status').textContent = 'Loading run details…';
  $('connection').textContent = 'Connecting to live updates…';
  const current = generation;
  fetch(`/api/runs/${encodeURIComponent(id)}`).then(response => {
    if (!response.ok) throw new Error('Request failed');
    return response.json();
  }).then(entry => { if (current === generation) showDetails(entry); })
    .catch(() => { if (current === generation) $('detail-status').textContent = 'Error loading run details.'; });
  const connection = new EventSource(`/api/runs/${encodeURIComponent(id)}/live`);
  stream = connection;
  connection.onopen = () => { if (current === generation) $('connection').textContent = 'Connected; events are observational.'; };
  connection.onerror = () => { if (current === generation) $('connection').textContent = 'Disconnected; reconnecting automatically.'; };
  connection.addEventListener('snapshot', event => {
    if (current !== generation) return;
    try {
      const events = JSON.parse(event.data);
      const timeline = $('timeline');
      // SSE messages are snapshots, including after reconnect: replace, never append.
      timeline.replaceChildren();
      for (const item of events) { const li = node('li'); renderValue(li, item); timeline.append(li); }
      if (!events.length) timeline.append(node('li', 'No lifecycle events.'));
    } catch { $('connection').textContent = 'Error reading lifecycle events.'; }
  });
}
$('refresh').addEventListener('click', refresh);
refresh();
setInterval(refresh, 5000);
