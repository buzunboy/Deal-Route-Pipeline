/**
 * The thin review test page. Deliberately minimal — per the build scope, the
 * production admin panel lives in a separate repo; this is just a harness over
 * the review API for system validation. It calls the same /api endpoints the
 * future panel will use. No build step, no framework.
 */
export const REVIEW_TEST_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DealRoute — Review (test harness)</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #1a1a1a; }
  header { background: #0b1f3a; color: #fff; padding: 12px 20px; }
  header small { opacity: .7; }
  main { padding: 20px; max-width: 1100px; margin: 0 auto; }
  .tabs { display: flex; gap: 8px; margin-bottom: 16px; }
  .tabs button { padding: 8px 14px; border: 1px solid #ccc; background: #fff; border-radius: 6px; cursor: pointer; }
  .tabs button.active { background: #0b1f3a; color: #fff; border-color: #0b1f3a; }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
  .row { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .muted { color: #667; font-size: 13px; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; background: #eef; }
  .warn { background: #fde8e8; color: #9b1c1c; }
  .ok { background: #e6f4ea; color: #1e6b34; }
  button.action { padding: 6px 12px; border-radius: 6px; border: 1px solid #0b1f3a; cursor: pointer; }
  button.approve { background: #1e6b34; color: #fff; border-color: #1e6b34; }
  button.reject { background: #fff; color: #9b1c1c; border-color: #9b1c1c; }
  code { background: #f0f1f3; padding: 1px 5px; border-radius: 4px; }
  .grounding { font-size: 13px; color: #445; margin-top: 6px; }
  .empty { color: #889; font-style: italic; }
</style>
</head>
<body>
<header>
  <strong>DealRoute — Review</strong> <small>test harness · LLM proposes, humans approve · nothing auto-publishes</small>
</header>
<main>
  <div class="tabs">
    <button data-tab="candidates" class="active">Candidates</button>
    <button data-tab="proposals">Field proposals</button>
    <button data-tab="manual">Manual capture</button>
  </div>
  <div id="content"><p class="empty">Loading…</p></div>
</main>
<script>
const content = document.getElementById('content');
let approver = localStorage.getItem('approver') || '';

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}

function esc(s) { return String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

async function renderCandidates() {
  const items = await api('/api/candidates');
  if (!items.length) { content.innerHTML = '<p class="empty">No candidates awaiting review.</p>'; return; }
  content.innerHTML = items.map(({ deal, evidence }) => \`
    <div class="card" data-id="\${deal.id}">
      <div class="row">
        <div>
          <strong>\${esc(deal.service)}</strong> via \${esc(deal.provider)}
          <span class="pill">\${esc(deal.route_type)}</span>
          <span class="pill \${deal.confidence > 0.7 ? 'ok' : 'warn'}">conf \${deal.confidence.toFixed(2)}</span>
        </div>
        <div>€\${deal.true_cost_monthly}/mo</div>
      </div>
      <div class="muted">\${esc(deal.headline)}</div>
      <div class="muted">evidence: \${evidence ? esc(evidence.id) : '<span class="warn">MISSING</span>'} · <a href="\${esc(deal.source_url)}" target="_blank" rel="noopener">source</a></div>
      <div class="grounding">\${(deal.grounding||[]).map(g => '<div>• <code>'+esc(g.field)+'</code> "'+esc(g.quote)+'"</div>').join('')}</div>
      <div style="margin-top:10px; display:flex; gap:8px;">
        <button class="action approve" onclick="decide('\${deal.id}','approve')">Approve → publish</button>
        <button class="action reject" onclick="decide('\${deal.id}','reject')">Reject → archive</button>
      </div>
    </div>\`).join('');
}

async function renderProposals() {
  const items = await api('/api/field-proposals');
  content.innerHTML = items.length
    ? items.map(p => \`<div class="card"><strong>\${esc(p.suggested_key)}</strong> <span class="pill">×\${p.count}</span><div class="muted">\${esc(p.label)} — \${esc(p.rationale)}</div></div>\`).join('')
    : '<p class="empty">No open field proposals.</p>';
}

async function renderManual() {
  const items = await api('/api/manual-capture-tasks');
  content.innerHTML = items.length
    ? items.map(t => \`<div class="card"><span class="pill warn">\${esc(t.reason)}</span> <a href="\${esc(t.source_url)}" target="_blank" rel="noopener">\${esc(t.source_url)}</a></div>\`).join('')
    : '<p class="empty">No open manual-capture tasks.</p>';
}

async function decide(id, action) {
  if (!approver) { approver = prompt('Your reviewer identity (recorded with the decision):') || ''; if (approver) localStorage.setItem('approver', approver); }
  if (!approver) return;
  try { await api('/api/candidates/'+id+'/'+action, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ approver }) }); renderCandidates(); }
  catch (e) { alert(action+' failed: '+e.message); }
}

const renderers = { candidates: renderCandidates, proposals: renderProposals, manual: renderManual };
document.querySelectorAll('.tabs button').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  content.innerHTML = '<p class="empty">Loading…</p>';
  renderers[btn.dataset.tab]().catch(e => content.innerHTML = '<p class="warn">'+esc(e.message)+'</p>');
}));
renderCandidates().catch(e => content.innerHTML = '<p class="warn">'+esc(e.message)+'</p>');
</script>
</body>
</html>`;
