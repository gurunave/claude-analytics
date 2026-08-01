/**
 * Router and data loading. Pages live in pages.js / upload.js; the drawing
 * primitives live in charts.js.
 *
 * Navigation is hash-based so the whole thing stays a static bundle with no
 * build step and no server-side routing.
 */

import { el, moveTip, hideTip, int } from './charts.js';
import { PAGES } from './pages.js';
import { uploadPage } from './upload.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const tooltip = document.getElementById('tooltip');
const sourceChip = document.getElementById('source-chip');

const ROUTES = { ...PAGES, upload: { label: 'Upload', render: null } };
const DEFAULT_ROUTE = 'overview';

const state = {
  days: 0,
  route: DEFAULT_ROUTE,
  /** null = this machine's transcripts; otherwise an uploaded dataset id. */
  source: null,
  report: null,
};

/* ---------- navigation ---------- */

function buildNav() {
  nav.innerHTML = '';
  for (const [key, page] of Object.entries(ROUTES)) {
    const a = el('a', {
      href: `#/${key}`,
      class: `tab${key === state.route ? ' active' : ''}`,
      text: page.label,
    });
    if (key === state.route) a.setAttribute('aria-current', 'page');
    nav.appendChild(a);
  }
}

function routeFromHash() {
  const key = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
  return ROUTES[key] ? key : DEFAULT_ROUTE;
}

/* ---------- rendering ---------- */

function renderRoute() {
  buildNav();
  // The range filter is meaningless on the upload page.
  document.getElementById('range').style.display = state.route === 'upload' ? 'none' : '';

  app.innerHTML = '';
  hideTip();

  if (state.route === 'upload') {
    app.appendChild(uploadPage(state.report, { onAnalyzed: useUploadedDataset }));
    return;
  }

  if (!state.report) {
    app.appendChild(el('div', { class: 'empty', text: 'Loading…' }));
    return;
  }
  if (!state.report.totals.turns) {
    app.appendChild(
      el('div', {
        class: 'empty',
        html:
          'No usage found in this range. Transcripts are read from <code>~/.claude/projects</code> — ' +
          'point the server elsewhere with <code>--dir</code>, or use the ' +
          '<a href="#/upload">Upload</a> page.',
      }),
    );
    return;
  }

  app.appendChild(ROUTES[state.route].render(state.report));
}

function renderChrome() {
  const r = state.report;
  if (!r) return;
  const t = r.totals;
  document.getElementById('subtitle').textContent = t.turns
    ? `${t.firstActivity} → ${t.lastActivity} · ${int(t.sessions)} sessions · ${int(t.projects)} projects · times in ${r.timeZone}`
    : 'No usage in the selected range.';

  if (r.source?.uploaded) {
    sourceChip.hidden = false;
    sourceChip.innerHTML = '';
    sourceChip.appendChild(el('span', { text: `Uploaded: ${r.source.label}` }));
    const clear = el('button', { class: 'chip-clear', text: '✕', title: 'Back to local transcripts' });
    clear.addEventListener('click', () => {
      state.source = null;
      load();
    });
    sourceChip.appendChild(clear);
  } else {
    sourceChip.hidden = true;
  }

  document.getElementById('foot').textContent =
    `Scanned ${int(r.scan.files)} transcript files in ${r.scan.root}` +
    (r.scan.skippedFiles ? ` · ${int(r.scan.skippedFiles)} skipped` : '') +
    (r.scan.parseErrors ? ` · ${int(r.scan.parseErrors)} unreadable lines` : '') +
    ` · generated ${new Date(r.generatedAt).toLocaleString()}`;
}

/* ---------- data ---------- */

async function load() {
  const params = new URLSearchParams();
  params.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  if (state.days) {
    params.set('since', new Date(Date.now() - state.days * 864e5).toISOString().slice(0, 10));
  }
  if (state.source) params.set('source', state.source);

  if (state.route !== 'upload') {
    app.innerHTML = '<div class="empty">Reading transcripts…</div>';
  }
  try {
    const res = await fetch(`/api/report?${params}`);
    const body = await res.json();
    if (!res.ok) {
      // A stale uploaded dataset (server restarted) falls back to local data.
      if (state.source) {
        state.source = null;
        return load();
      }
      throw new Error(body.error ?? `server returned ${res.status}`);
    }
    state.report = body;
    renderChrome();
    renderRoute();
  } catch (err) {
    app.innerHTML = '';
    app.appendChild(el('div', { class: 'empty', text: `Could not load usage data: ${err.message}` }));
  }
}

function useUploadedDataset(result) {
  state.source = result.id;
  state.route = 'overview';
  // replaceState rather than assigning location.hash: assigning would fire
  // hashchange and render the overview against the *old* dataset before the
  // new one arrives. load() renders exactly once, with the uploaded data.
  history.replaceState(null, '', '#/overview');
  load();
}

/* ---------- controls ---------- */

function wireSegmented(id, onPick) {
  document.getElementById(id).addEventListener('click', (evt) => {
    const btn = evt.target.closest('button');
    if (!btn) return;
    for (const b of evt.currentTarget.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-pressed', 'true');
    onPick(btn);
  });
}

wireSegmented('range', (btn) => {
  state.days = Number(btn.dataset.days);
  load();
});

wireSegmented('theme', (btn) => {
  const mode = btn.dataset.theme;
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
});

window.addEventListener('hashchange', () => {
  state.route = routeFromHash();
  renderRoute();
});

window.addEventListener('pointermove', (evt) => {
  if (tooltip.style.opacity === '1') moveTip(evt);
});

state.route = routeFromHash();
buildNav();
load();
