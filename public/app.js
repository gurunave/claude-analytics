/**
 * Dashboard front-end. Fetches /api/report and renders hand-rolled SVG charts.
 * No external dependencies.
 */

const NS = 'http://www.w3.org/2000/svg';
const SERIES = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
const SEQ = ['var(--seq-100)', 'var(--seq-250)', 'var(--seq-400)', 'var(--seq-550)', 'var(--seq-700)'];

const tooltip = document.getElementById('tooltip');
const app = document.getElementById('app');

let state = { days: 0, report: null };

/* ---------- formatting ---------- */

const usd = (n) => {
  if (n === 0) return '$0';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
};
const tok = (n) => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
};
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const int = (n) => Math.round(n).toLocaleString('en-US');
const dur = (ms) => {
  if (!ms) return '—';
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const shortPath = (p) => {
  if (!p) return 'unknown';
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
};

/* ---------- DOM helpers ---------- */

function el(tag, attrs = {}, children = []) {
  const isSvg = ['svg', 'g', 'rect', 'path', 'line', 'text', 'circle', 'title'].includes(tag);
  const node = isSvg ? document.createElementNS(NS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.appendChild(c);
  return node;
}

function card(title, hint, ...body) {
  const c = el('div', { class: 'card' }, [el('h2', { text: title })]);
  if (hint) c.appendChild(el('p', { class: 'hint', text: hint }));
  for (const b of body) if (b) c.appendChild(b);
  return c;
}

/* ---------- tooltip ---------- */

function showTip(evt, title, rows) {
  tooltip.innerHTML = '';
  tooltip.appendChild(el('div', { class: 't-title', text: title }));
  for (const [k, v] of rows) {
    tooltip.appendChild(
      el('div', { class: 't-row' }, [el('span', { text: k }), el('b', { text: v })]),
    );
  }
  tooltip.style.opacity = '1';
  moveTip(evt);
}

function moveTip(evt) {
  const pad = 14;
  const r = tooltip.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
}

const hideTip = () => { tooltip.style.opacity = '0'; };

/* ---------- charts ---------- */

/**
 * Daily cost over time: filled area under a 2px line, with a crosshair that
 * snaps to the nearest day.
 */
function lineChart(daily) {
  const W = 900;
  const H = 260;
  const m = { top: 14, right: 16, bottom: 26, left: 54 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;

  const max = Math.max(...daily.map((d) => d.cost), 0.0001);
  const x = (i) => (daily.length === 1 ? iw / 2 : (i / (daily.length - 1)) * iw);
  const y = (v) => ih - (v / max) * ih;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Daily spend' });
  const g = el('g', { transform: `translate(${m.left},${m.top})` });
  svg.appendChild(g);

  // Recessive gridlines + axis ticks.
  for (let i = 0; i <= 4; i += 1) {
    const v = (max / 4) * i;
    g.appendChild(el('line', { class: 'grid-line', x1: 0, x2: iw, y1: y(v), y2: y(v) }));
    g.appendChild(
      el('text', { class: 'axis-label', x: -10, y: y(v) + 4, 'text-anchor': 'end', text: usd(v) }),
    );
  }

  const pts = daily.map((d, i) => [x(i), y(d.cost)]);
  if (daily.length === 1) {
    // A one-day range has no line to draw — show the single value as a mark
    // with a direct label rather than a degenerate zero-width path.
    const [px, py] = pts[0];
    g.appendChild(el('circle', { cx: px, cy: py, r: 5, fill: 'var(--series-1)' }));
    g.appendChild(
      el('text', { class: 'mark-value', x: px, y: py - 12, 'text-anchor': 'middle', text: usd(daily[0].cost) }),
    );
  } else {
    const linePath = pts
      .map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`)
      .join('');
    g.appendChild(
      el('path', {
        d: `${linePath}L${pts.at(-1)[0].toFixed(1)},${ih}L${pts[0][0].toFixed(1)},${ih}Z`,
        fill: 'var(--series-1)',
        'fill-opacity': '0.12',
      }),
    );
    g.appendChild(
      el('path', {
        d: linePath,
        fill: 'none',
        stroke: 'var(--series-1)',
        'stroke-width': '2',
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }),
    );
  }
  g.appendChild(el('line', { class: 'axis-line', x1: 0, x2: iw, y1: ih, y2: ih }));

  // Date ticks: first, middle, last — enough to orient without collisions.
  const ticks = daily.length > 2 ? [0, Math.floor(daily.length / 2), daily.length - 1] : daily.map((_, i) => i);
  for (const i of new Set(ticks)) {
    g.appendChild(
      el('text', {
        class: 'axis-label',
        x: x(i),
        y: ih + 17,
        'text-anchor': i === 0 ? 'start' : i === daily.length - 1 ? 'end' : 'middle',
        text: daily[i].date.slice(5),
      }),
    );
  }

  const crosshair = el('line', {
    class: 'axis-line',
    y1: 0,
    y2: ih,
    stroke: 'var(--text-muted)',
    opacity: '0',
  });
  const marker = el('circle', {
    r: 4.5,
    fill: 'var(--series-1)',
    stroke: 'var(--surface-1)',
    'stroke-width': '2',
    opacity: '0',
  });
  g.appendChild(crosshair);
  g.appendChild(marker);

  // Full-plot hit area so the crosshair tracks anywhere, not just on the line.
  const hit = el('rect', { x: 0, y: 0, width: iw, height: ih, fill: 'transparent' });
  hit.style.cursor = 'crosshair';
  g.appendChild(hit);

  hit.addEventListener('pointermove', (evt) => {
    const box = hit.getBoundingClientRect();
    const rel = ((evt.clientX - box.left) / box.width) * iw;
    const i = Math.max(0, Math.min(daily.length - 1, Math.round((rel / iw) * (daily.length - 1))));
    const d = daily[i];
    crosshair.setAttribute('x1', x(i));
    crosshair.setAttribute('x2', x(i));
    crosshair.setAttribute('opacity', '0.5');
    marker.setAttribute('cx', x(i));
    marker.setAttribute('cy', y(d.cost));
    marker.setAttribute('opacity', '1');
    showTip(evt, d.date, [
      ['Spend', usd(d.cost)],
      ['Cumulative', usd(d.cumulativeCost)],
      ['Turns', int(d.turns)],
      ['Output tokens', tok(d.outputTokens)],
      ['Cache hit', pct(d.cacheReadTokens / Math.max(1, d.inputTokens + d.cacheReadTokens + d.cacheWriteTokens))],
    ]);
  });
  hit.addEventListener('pointerleave', () => {
    crosshair.setAttribute('opacity', '0');
    marker.setAttribute('opacity', '0');
    hideTip();
  });

  return svg;
}

/**
 * Horizontal bars with a direct value label on every row. The label is the
 * relief for light-mode series colors that sit below 3:1 on the surface.
 */
function barsH(rows, { key, value, format = usd, colorFn, tipRows, width = 900 }) {
  const rowH = 30;
  // The SVG scales to its container, which shrinks text with it. Half-width
  // cards therefore get a narrower viewBox so type renders near 1:1.
  const W = width;
  const labelW = Math.round(W * 0.3);
  const H = rows.length * rowH + 8;
  const barW = W - labelW - Math.round(W * 0.1);
  const max = Math.max(...rows.map((r) => r[value]), 1e-9);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  rows.forEach((r, i) => {
    const y = i * rowH + 4;
    const w = Math.max(2, (r[value] / max) * barW);
    const g = el('g');
    g.appendChild(
      el('text', {
        class: 'mark-label',
        x: labelW - 12,
        y: y + 15,
        'text-anchor': 'end',
        text: (() => {
          const maxChars = Math.floor(labelW / 6.6);
          const s = String(r[key]);
          return s.length > maxChars ? `…${s.slice(-(maxChars - 1))}` : s;
        })(),
      }),
    );
    // 4px rounded data-end; the bar is anchored to the baseline at labelW.
    g.appendChild(
      el('rect', {
        x: labelW,
        y: y + 3,
        width: w,
        height: 16,
        rx: 4,
        fill: colorFn ? colorFn(r, i) : SERIES[i % 8],
      }),
    );
    g.appendChild(
      el('text', { class: 'mark-value', x: labelW + w + 10, y: y + 15, text: format(r[value]) }),
    );

    const hit = el('rect', { x: 0, y, width: W, height: rowH, fill: 'transparent' });
    hit.addEventListener('pointermove', (evt) => showTip(evt, String(r[key]), tipRows(r)));
    hit.addEventListener('pointerleave', hideTip);
    g.appendChild(hit);
    svg.appendChild(g);
  });
  return svg;
}

/** A legend that doubles as direct labelling: swatch, name, and the value. */
function legend(rows, { key, value, format = usd, colorFn }) {
  const box = el('div', { class: 'legend' });
  rows.forEach((r, i) => {
    box.appendChild(
      el('div', { class: 'item' }, [
        el('span', {
          class: 'swatch',
          style: `background:${colorFn ? colorFn(r, i) : SERIES[i % 8]}`,
        }),
        el('span', { text: String(r[key]) }),
        el('span', { class: 'amount', text: format(r[value]) }),
      ]),
    );
  });
  return box;
}

/** Single stacked bar showing how spend splits across billing categories. */
function stackedBar(segments) {
  const W = 900;
  const H = 44;
  const total = segments.reduce((n, s) => n + s.value, 0) || 1;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  let x = 0;
  segments.forEach((s, i) => {
    const w = (s.value / total) * W;
    if (w <= 0) return;
    const g = el('g');
    // 2px surface gap between adjacent segments so fills never touch.
    g.appendChild(
      el('rect', {
        x: x + (i === 0 ? 0 : 1),
        y: 6,
        width: Math.max(1, w - (i === 0 ? 1 : 2)),
        height: 20,
        rx: 4,
        fill: s.color,
      }),
    );
    if (w > 64) {
      g.appendChild(
        el('text', {
          class: 'mark-value',
          x: x + w / 2,
          y: 40,
          'text-anchor': 'middle',
          text: `${pct(s.value / total)}`,
        }),
      );
    }
    const hit = el('rect', { x, y: 0, width: w, height: H, fill: 'transparent' });
    hit.addEventListener('pointermove', (evt) =>
      showTip(evt, s.label, [
        ['Cost', usd(s.value)],
        ['Share', pct(s.value / total)],
        ...(s.tokens !== undefined ? [['Tokens', tok(s.tokens)]] : []),
      ]),
    );
    hit.addEventListener('pointerleave', hideTip);
    g.appendChild(hit);
    svg.appendChild(g);
    x += w;
  });
  return svg;
}

/** Weekday × hour activity heatmap on the single-hue sequential blue ramp. */
function heatmap(matrix, timeZone) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const cell = 30;
  const gap = 2;
  const left = 38;
  const top = 20;
  const W = left + 24 * cell;
  const H = top + 7 * cell + 8;
  const max = Math.max(...matrix.flat(), 1e-9);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Activity by weekday and hour' });

  for (let h = 0; h < 24; h += 3) {
    svg.appendChild(
      el('text', { class: 'axis-label', x: left + h * cell + (cell - gap) / 2, y: 12, 'text-anchor': 'middle', text: String(h) }),
    );
  }
  matrix.forEach((row, d) => {
    svg.appendChild(
      el('text', { class: 'axis-label', x: left - 8, y: top + d * cell + 19, 'text-anchor': 'end', text: days[d] }),
    );
    row.forEach((v, h) => {
      // Zero stays at the surface; non-zero starts at the second ramp step so
      // "a little" is still visible against the background.
      const ratio = v / max;
      const fill = v === 0 ? 'var(--grid)' : SEQ[Math.min(SEQ.length - 1, 1 + Math.floor(ratio * (SEQ.length - 1)))];
      const rect = el('rect', {
        x: left + h * cell,
        y: top + d * cell,
        width: cell - gap,
        height: cell - gap,
        rx: 4,
        fill,
      });
      rect.addEventListener('pointermove', (evt) =>
        showTip(evt, `${days[d]} ${String(h).padStart(2, '0')}:00`, [
          ['Spend', usd(v)],
          ['Timezone', timeZone],
        ]),
      );
      rect.addEventListener('pointerleave', hideTip);
      svg.appendChild(rect);
    });
  });
  return svg;
}

/** Table view — the relief for sub-3:1 series colors, and the accessible fallback. */
function table(head, rows, { scroll = false } = {}) {
  const t = el('table');
  const thead = el('thead');
  const tr = el('tr');
  for (const h of head) tr.appendChild(el('th', { class: h.num ? 'num' : '', text: h.label }));
  thead.appendChild(tr);
  t.appendChild(thead);
  const tbody = el('tbody');
  for (const row of rows) {
    const r = el('tr');
    row.forEach((cellValue, i) => {
      const td = el('td', { class: head[i].num ? 'num' : head[i].cls ?? '' });
      if (cellValue instanceof Node) td.appendChild(cellValue);
      else td.textContent = cellValue;
      r.appendChild(td);
    });
    tbody.appendChild(r);
  }
  t.appendChild(tbody);
  return scroll ? el('div', { class: 'scroll' }, [t]) : t;
}

function collapsibleTable(label, node) {
  const wrap = el('div');
  const btn = el('button', { class: 'table-toggle', text: `▸ ${label}` });
  const holder = el('div');
  holder.style.display = 'none';
  holder.appendChild(node);
  btn.addEventListener('click', () => {
    const open = holder.style.display !== 'none';
    holder.style.display = open ? 'none' : 'block';
    btn.textContent = `${open ? '▸' : '▾'} ${label}`;
  });
  wrap.appendChild(btn);
  wrap.appendChild(holder);
  return wrap;
}

/* ---------- tiles ---------- */

function tiles(t) {
  const items = [
    { label: 'Total spend', value: usd(t.cost), note: `${int(t.turns)} assistant turns` },
    {
      label: 'Saved by caching',
      value: usd(t.cacheSavings),
      note: `${pct(t.cacheHitRate)} of prompt tokens read from cache`,
      good: true,
    },
    { label: 'Tokens', value: tok(t.totalTokens), note: `${tok(t.outputTokens)} generated` },
    { label: 'Sessions', value: int(t.sessions), note: `across ${int(t.projects)} projects` },
    { label: 'Median session', value: usd(t.medianSessionCost), note: `p95 ${usd(t.p95SessionCost)}` },
    { label: 'Per active day', value: usd(t.avgCostPerActiveDay), note: `${int(t.activeDays)} active days` },
  ];
  const grid = el('div', { class: 'tiles' });
  for (const i of items) {
    grid.appendChild(
      el('div', { class: 'tile' }, [
        el('div', { class: 'label', text: i.label }),
        el('div', { class: 'value', text: i.value }),
        el('div', { class: `note${i.good ? ' good' : ''}`, text: i.note }),
      ]),
    );
  }
  return grid;
}

/* ---------- render ---------- */

function render(report) {
  const t = report.totals;
  app.innerHTML = '';

  if (!t.turns) {
    app.appendChild(
      el('div', {
        class: 'empty',
        html:
          'No usage found in this range. Transcripts are read from <code>~/.claude/projects</code> — ' +
          'point the server at a different directory with <code>--dir</code>.',
      }),
    );
    return;
  }

  document.getElementById('subtitle').textContent =
    `${t.firstActivity} → ${t.lastActivity} · ${int(t.sessions)} sessions · ${int(t.projects)} projects · times in ${report.timeZone}`;

  app.appendChild(tiles(t));

  app.appendChild(
    card(
      'Spend over time',
      'Daily cost across all projects. Hover for the day’s breakdown.',
      lineChart(report.daily),
    ),
  );

  // Cost composition — where the money actually goes.
  const comp = [
    { label: 'Output', value: t.costOutput, tokens: t.outputTokens, color: SERIES[0] },
    { label: 'Cache writes', value: t.costCacheWrite, tokens: t.cacheWriteTokens, color: SERIES[1] },
    { label: 'Uncached input', value: t.costInput, tokens: t.inputTokens, color: SERIES[2] },
    { label: 'Cache reads', value: t.costCacheRead, tokens: t.cacheReadTokens, color: SERIES[3] },
  ].filter((s) => s.value > 0);
  app.appendChild(
    card(
      'What you are paying for',
      'Cache reads bill at 0.1× input; writes at 1.25× (5-minute) or 2× (1-hour).',
      stackedBar(comp),
      legend(comp, { key: 'label', value: 'value' }),
      collapsibleTable(
        'Show as table',
        table(
          [{ label: 'Category' }, { label: 'Cost', num: true }, { label: 'Share', num: true }, { label: 'Tokens', num: true }],
          comp.map((s) => [s.label, usd(s.value), pct(s.value / (t.cost || 1)), tok(s.tokens)]),
        ),
      ),
    ),
  );

  const grid = el('div', { class: 'grid-2' });

  const models = report.byModel.slice(0, 8);
  grid.appendChild(
    card(
      'Spend by model',
      null,
      barsH(models, {
        key: 'model',
        value: 'cost',
        width: 520,
        tipRows: (r) => [
          ['Cost', usd(r.cost)],
          ['Turns', int(r.turns)],
          ['Output', tok(r.outputTokens)],
          ['Cost / turn', usd(r.cost / Math.max(1, r.turns))],
        ],
      }),
      collapsibleTable(
        'Show as table',
        table(
          [{ label: 'Model' }, { label: 'Cost', num: true }, { label: 'Turns', num: true }, { label: 'Output', num: true }],
          models.map((r) => [r.model, usd(r.cost), int(r.turns), tok(r.outputTokens)]),
        ),
      ),
    ),
  );

  const projects = report.byProject.slice(0, 8).map((p) => ({ ...p, short: shortPath(p.project) }));
  grid.appendChild(
    card(
      'Spend by project',
      null,
      barsH(projects, {
        key: 'short',
        value: 'cost',
        width: 520,
        colorFn: () => SERIES[0],
        tipRows: (r) => [
          ['Cost', usd(r.cost)],
          ['Turns', int(r.turns)],
          ['Path', r.project],
        ],
      }),
      collapsibleTable(
        'Show as table',
        table(
          [{ label: 'Project', cls: 'mono truncate' }, { label: 'Cost', num: true }, { label: 'Turns', num: true }],
          projects.map((r) => [r.project, usd(r.cost), int(r.turns)]),
        ),
      ),
    ),
  );
  app.appendChild(grid);

  app.appendChild(
    card(
      'When you work',
      `Spend by weekday and hour of day (${report.timeZone}).`,
      heatmap(report.heatmap, report.timeZone),
    ),
  );

  const grid2 = el('div', { class: 'grid-2' });

  const tools = report.byTool.slice(0, 12);
  if (tools.length) {
    grid2.appendChild(
      card(
        'Tool usage',
        `${int(t.toolInvocations)} tool calls across ${int(t.turns)} turns.`,
        table(
          [{ label: 'Tool' }, { label: 'Calls', num: true }, { label: 'Share', num: true }],
          tools.map((r) => [
            el('span', {}, [
              el('span', { class: 'dot', style: `background:${r.mcp ? SERIES[6] : SERIES[0]}` }),
              document.createTextNode(r.tool),
            ]),
            int(r.count),
            pct(r.share),
          ]),
        ),
      ),
    );
  }

  const efforts = report.byEffort.filter((e) => e.effort !== 'unset');
  grid2.appendChild(
    card(
      'Reasoning effort',
      'Turn counts and cost by the effort level the session ran at.',
      table(
        [{ label: 'Effort' }, { label: 'Turns', num: true }, { label: 'Cost', num: true }, { label: 'Cost / turn', num: true }],
        (efforts.length ? efforts : report.byEffort).map((r) => [
          r.effort,
          int(r.turns),
          usd(r.cost),
          usd(r.cost / Math.max(1, r.turns)),
        ]),
      ),
    ),
  );
  app.appendChild(grid2);

  app.appendChild(
    card(
      'Sessions',
      'Most expensive first. Hover a row for the opening prompt.',
      table(
        [
          { label: 'Started' },
          { label: 'Project', cls: 'mono truncate' },
          { label: 'Branch', cls: 'truncate' },
          { label: 'Turns', num: true },
          { label: 'Duration', num: true },
          { label: 'Cost', num: true },
        ],
        report.sessions.slice(0, 100).map((s) => {
          const row = [
            s.start ? new Date(s.start).toLocaleString() : '—',
            shortPath(s.project),
            s.branch ?? '—',
            int(s.turns),
            dur(s.durationMs),
            usd(s.cost),
          ];
          return row;
        }),
        { scroll: true },
      ),
    ),
  );

  document.getElementById('foot').textContent =
    `Scanned ${int(report.scan.files)} transcript files in ${report.scan.root}` +
    (report.scan.skippedFiles ? ` · ${report.scan.skippedFiles} skipped` : '') +
    ` · generated ${new Date(report.generatedAt).toLocaleString()}`;
}

/* ---------- data + controls ---------- */

async function load() {
  const params = new URLSearchParams();
  params.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  if (state.days) {
    const since = new Date(Date.now() - state.days * 864e5);
    params.set('since', since.toISOString().slice(0, 10));
  }
  app.innerHTML = '<div class="empty">Reading transcripts…</div>';
  try {
    const res = await fetch(`/api/report?${params}`);
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    state.report = await res.json();
    render(state.report);
  } catch (err) {
    app.innerHTML = `<div class="empty">Could not load usage data: ${err.message}</div>`;
  }
}

document.getElementById('range').addEventListener('click', (evt) => {
  const btn = evt.target.closest('button');
  if (!btn) return;
  for (const b of evt.currentTarget.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
  btn.setAttribute('aria-pressed', 'true');
  state.days = Number(btn.dataset.days);
  load();
});

document.getElementById('theme').addEventListener('click', (evt) => {
  const btn = evt.target.closest('button');
  if (!btn) return;
  for (const b of evt.currentTarget.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
  btn.setAttribute('aria-pressed', 'true');
  const mode = btn.dataset.theme;
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
});

window.addEventListener('pointermove', (evt) => {
  if (tooltip.style.opacity === '1') moveTip(evt);
});

load();
