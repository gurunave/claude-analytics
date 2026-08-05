/**
 * One render function per page. Each takes the report and returns a
 * DocumentFragment; the router swaps them into #app.
 */

import {
  SERIES, usd, tok, pct, int, dur, shortPath,
  el, card, lineChart, barsH, legend, stackedBar, heatmap, scatter, multiSelect,
  table, collapsibleTable,
} from './charts.js';

function frag(...nodes) {
  const f = document.createDocumentFragment();
  for (const n of nodes) if (n) f.appendChild(n);
  return f;
}

function note(text) {
  return el('div', { class: 'empty', text });
}

/* ---------- overview ---------- */

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

function overview(report) {
  const t = report.totals;
  const comp = [
    { label: 'Output', value: t.costOutput, tokens: t.outputTokens, color: SERIES[0] },
    { label: 'Cache writes', value: t.costCacheWrite, tokens: t.cacheWriteTokens, color: SERIES[1] },
    { label: 'Uncached input', value: t.costInput, tokens: t.inputTokens, color: SERIES[2] },
    { label: 'Cache reads', value: t.costCacheRead, tokens: t.cacheReadTokens, color: SERIES[3] },
  ].filter((s) => s.value > 0);

  return frag(
    tiles(t),
    card(
      'Spend over time',
      'Daily cost across all projects. Hover for the day’s breakdown.',
      lineChart(report.daily),
    ),
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
}

/* ---------- blended price vs capability ---------- */

const TIER_COLORS = {
  opus: SERIES[0],
  fable: SERIES[6],
  sonnet: SERIES[2],
  haiku: SERIES[3],
  unknown: SERIES[7],
};

const price = (n) => (n === null || n === undefined ? '—' : `$${n.toFixed(2)}`);

/** Distinct values in first-appearance order, which is cost order here. */
function distinct(rows, valueKey, labelKey) {
  const seen = new Map();
  for (const r of rows) if (!seen.has(r[valueKey])) seen.set(r[valueKey], r[labelKey]);
  return [...seen.entries()].map(([value, label]) => ({ value, label }));
}

/**
 * Price against capability, one point per model.
 *
 * The filters are the point of the card: models are only comparable when you
 * choose what to compare, and effective price depends on which providers'
 * turns are counted — so both selections re-derive the points from the
 * (model, provider) rows rather than hiding pre-computed ones.
 */
function priceCapabilityCard(report) {
  const all = report.priceCapability?.rows ?? [];
  if (!all.length) return null;

  const providerOptions = distinct(all, 'provider', 'providerLabel');
  const modelOptions = distinct(all, 'model', 'modelDisplay');
  const state = {
    providers: new Set(providerOptions.map((o) => o.value)),
    models: new Set(modelOptions.map((o) => o.value)),
    mode: 'effective',
  };

  const wrap = el('div', { class: 'card' }, [
    el('h2', { text: 'Blended price vs capability index' }),
    el('p', {
      class: 'hint',
      text:
        'One point per model: capability index up, blended price across. Bigger dots are more ' +
        'spend, and up-and-left is better value. The capability index is an ordinal ranking in ' +
        'src/pricing.js, not a benchmark score — edit it if your ordering differs.',
    }),
  ]);

  const controls = el('div', { class: 'filter-row' });
  controls.appendChild(
    multiSelect('Providers', providerOptions, {
      selected: [...state.providers],
      onChange: (vals) => {
        state.providers = new Set(vals);
        draw();
      },
    }),
  );
  controls.appendChild(
    multiSelect('Models', modelOptions, {
      selected: [...state.models],
      colorFn: (opt) => TIER_COLORS[all.find((r) => r.model === opt.value)?.tier] ?? SERIES[7],
      onChange: (vals) => {
        state.models = new Set(vals);
        draw();
      },
    }),
  );

  const modeSeg = el('div', { class: 'seg' }, [
    el('button', { 'data-mode': 'effective', 'aria-pressed': 'true', text: 'Effective' }),
    el('button', { 'data-mode': 'list', 'aria-pressed': 'false', text: 'List price' }),
  ]);
  modeSeg.addEventListener('click', (evt) => {
    const btn = evt.target.closest('button');
    if (!btn) return;
    for (const b of modeSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-pressed', 'true');
    state.mode = btn.dataset.mode;
    draw();
  });
  controls.appendChild(el('div', { class: 'filter-mode' }, [
    el('span', { class: 'filter-mode-label', text: 'Price basis' }),
    modeSeg,
  ]));
  wrap.appendChild(controls);

  const holder = el('div');
  wrap.appendChild(holder);

  /** Collapse the selected (model, provider) rows down to one row per model. */
  function points() {
    const byModel = new Map();
    for (const r of all) {
      if (!state.providers.has(r.provider) || !state.models.has(r.model)) continue;
      let p = byModel.get(r.model);
      if (!p) {
        p = {
          model: r.model,
          label: r.modelDisplay,
          tier: r.tier,
          capability: r.capability,
          listBlended: r.listBlended,
          listInput: r.listInput,
          listOutput: r.listOutput,
          providers: new Set(),
          cost: 0,
          turns: 0,
          totalTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
        };
        byModel.set(r.model, p);
      }
      p.providers.add(r.providerLabel);
      p.cost += r.cost;
      p.turns += r.turns;
      p.totalTokens += r.totalTokens;
      p.outputTokens += r.outputTokens;
      p.cacheReadTokens += r.cacheReadTokens;
    }
    for (const p of byModel.values()) {
      p.effectiveBlended = p.totalTokens ? (p.cost / p.totalTokens) * 1e6 : null;
      p.blended = state.mode === 'list' ? p.listBlended : p.effectiveBlended;
      // Capability bought per dollar per million tokens — the value ranking
      // the scatter shows geometrically.
      p.perDollar = p.blended > 0 && p.capability !== null ? p.capability / p.blended : null;
    }
    return [...byModel.values()].sort((a, b) => b.cost - a.cost);
  }

  function draw() {
    holder.innerHTML = '';
    const rows = points();
    if (!rows.length) {
      holder.appendChild(note('Nothing selected. Pick at least one provider and one model.'));
      return;
    }
    const plottable = rows.filter((r) => r.capability !== null && r.blended > 0);
    if (!plottable.length) {
      holder.appendChild(
        note('The selected models have no capability index or no billed tokens to price.'),
      );
    } else {
      holder.appendChild(
        scatter(plottable, {
          x: 'blended',
          y: 'capability',
          size: 'cost',
          label: 'label',
          colorFn: (p) => TIER_COLORS[p.tier] ?? SERIES[7],
          xLabel:
            state.mode === 'list'
              ? `List blended price, $/MTok (${pct(report.priceCapability.blendInputShare)} input)`
              : 'Effective blended price, $/MTok (what you actually paid)',
          yLabel: 'Capability index',
          tipRows: (p) => [
            ['Capability', String(p.capability)],
            ['Effective', `${price(p.effectiveBlended)}/MTok`],
            ['List', `${price(p.listBlended)}/MTok`],
            ['Index per $', p.perDollar === null ? '—' : p.perDollar.toFixed(1)],
            ['Spend', usd(p.cost)],
            ['Tokens', tok(p.totalTokens)],
            ['Provider', [...p.providers].join(', ')],
          ],
        }),
      );
      const tiers = [...new Set(plottable.map((p) => p.tier))];
      holder.appendChild(
        el('div', { class: 'legend' },
          tiers.map((t) =>
            el('div', { class: 'item' }, [
              el('span', { class: 'swatch', style: `background:${TIER_COLORS[t] ?? SERIES[7]}` }),
              el('span', { text: t }),
            ]),
          ),
        ),
      );
      const skipped = rows.length - plottable.length;
      if (skipped) {
        holder.appendChild(
          el('p', { class: 'hint', text: `${int(skipped)} model(s) not plotted — no capability index or no billed tokens.` }),
        );
      }
    }

    holder.appendChild(
      collapsibleTable(
        'Show as table',
        table(
          [
            { label: 'Model' }, { label: 'Provider' }, { label: 'Capability', num: true },
            { label: 'Effective $/MTok', num: true }, { label: 'List $/MTok', num: true },
            { label: 'Index per $', num: true }, { label: 'Spend', num: true },
            { label: 'Tokens', num: true },
          ],
          rows.map((r) => [
            r.label,
            [...r.providers].join(', '),
            r.capability === null ? '—' : String(r.capability),
            price(r.effectiveBlended),
            price(r.listBlended),
            r.perDollar === null ? '—' : r.perDollar.toFixed(1),
            usd(r.cost),
            tok(r.totalTokens),
          ]),
        ),
      ),
    );
  }

  draw();
  return wrap;
}

/* ---------- models ---------- */

function models(report) {
  const rows = report.byModel.slice(0, 8);
  const efforts = report.byEffort.filter((e) => e.effort !== 'unset');
  const grid = el('div', { class: 'grid-2' });

  grid.appendChild(
    card(
      'Reasoning effort',
      'Turns and cost by the effort level each request ran at.',
      table(
        [{ label: 'Effort' }, { label: 'Turns', num: true }, { label: 'Cost', num: true }, { label: 'Cost / turn', num: true }],
        (efforts.length ? efforts : report.byEffort).map((r) => [
          r.effort, int(r.turns), usd(r.cost), usd(r.cost / Math.max(1, r.turns)),
        ]),
      ),
    ),
  );
  grid.appendChild(
    card(
      'How turns ended',
      'Stop reasons — a high max_tokens share means responses are being truncated.',
      table(
        [{ label: 'Stop reason' }, { label: 'Turns', num: true }, { label: 'Share', num: true }],
        report.byStopReason.map((r) => [
          r.stopReason, int(r.turns), pct(r.turns / Math.max(1, report.totals.turns)),
        ]),
      ),
    ),
  );

  return frag(
    card(
      'Spend by model',
      'Each model gets a fixed colour so it keeps its identity across the dashboard.',
      barsH(rows, {
        key: 'model', value: 'cost',
        tipRows: (r) => [
          ['Cost', usd(r.cost)], ['Turns', int(r.turns)],
          ['Output', tok(r.outputTokens)], ['Cost / turn', usd(r.cost / Math.max(1, r.turns))],
        ],
      }),
      collapsibleTable(
        'Show as table',
        table(
          [{ label: 'Model' }, { label: 'Cost', num: true }, { label: 'Turns', num: true },
           { label: 'Output', num: true }, { label: 'Cache hit', num: true }],
          rows.map((r) => [
            r.model, usd(r.cost), int(r.turns), tok(r.outputTokens),
            pct(r.cacheReadTokens / Math.max(1, r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens)),
          ]),
        ),
      ),
    ),
    priceCapabilityCard(report),
    grid,
    report.byProvider?.length > 1
      ? card(
          'Serving platform',
          'Read from the model id: Bedrock carries an anthropic. prefix, Vertex an @version suffix. All routes are costed at first-party rates.',
          table(
            [{ label: 'Platform' }, { label: 'Turns', num: true }, { label: 'Cost', num: true }],
            report.byProvider.map((r) => [r.provider, int(r.turns), usd(r.cost)]),
          ),
        )
      : null,
    card(
      'CLI versions',
      'Useful for spotting when usage shifted after an upgrade.',
      table(
        [{ label: 'Version' }, { label: 'Turns', num: true }, { label: 'Cost', num: true }],
        report.byVersion.slice(0, 12).map((r) => [r.version, int(r.turns), usd(r.cost)]),
      ),
    ),
  );
}

/* ---------- projects ---------- */

function projects(report) {
  const rows = report.byProject.slice(0, 12).map((p) => ({ ...p, short: shortPath(p.project) }));
  const branches = report.byBranch.slice(0, 12);

  return frag(
    card(
      'Spend by project',
      `${int(report.totals.projects)} projects, most expensive first.`,
      barsH(rows, {
        key: 'short', value: 'cost',
        colorFn: () => SERIES[0],
        tipRows: (r) => [['Cost', usd(r.cost)], ['Turns', int(r.turns)], ['Path', r.project]],
      }),
      collapsibleTable(
        'Show as table',
        table(
          [{ label: 'Project', cls: 'mono truncate' }, { label: 'Cost', num: true },
           { label: 'Turns', num: true }, { label: 'Output', num: true }],
          rows.map((r) => [r.project, usd(r.cost), int(r.turns), tok(r.outputTokens)]),
        ),
      ),
    ),
    branches.length
      ? card(
          'Spend by git branch',
          'Branches are recorded per turn, so a session that switched branches is split across rows.',
          barsH(branches, {
            key: 'branch', value: 'cost',
            colorFn: () => SERIES[2],
            tipRows: (r) => [['Cost', usd(r.cost)], ['Turns', int(r.turns)]],
          }),
        )
      : null,
  );
}

/* ---------- activity ---------- */

function activity(report) {
  const hours = report.hourly
    .map((h) => ({ ...h, label: `${String(h.hour).padStart(2, '0')}:00` }))
    .filter((h) => h.turns > 0);

  return frag(
    card(
      'When you work',
      `Spend by weekday and hour of day (${report.timeZone}). Darker means more spend.`,
      heatmap(report.heatmap, report.timeZone),
    ),
    card(
      'Spend by hour of day',
      'Aggregated across every weekday.',
      hours.length
        ? barsH(hours, {
            key: 'label', value: 'cost',
            colorFn: () => SERIES[0],
            tipRows: (r) => [['Cost', usd(r.cost)], ['Turns', int(r.turns)], ['Output', tok(r.outputTokens)]],
          })
        : note('No activity in this range.'),
    ),
    card(
      'Daily detail',
      null,
      table(
        [{ label: 'Date' }, { label: 'Cost', num: true }, { label: 'Cumulative', num: true },
         { label: 'Turns', num: true }, { label: 'Output', num: true }],
        [...report.daily].reverse().map((d) => [
          d.date, usd(d.cost), usd(d.cumulativeCost), int(d.turns), tok(d.outputTokens),
        ]),
        { scroll: true },
      ),
    ),
  );
}

/* ---------- tools ---------- */

function tools(report) {
  if (!report.byTool.length) return frag(note('No tool calls recorded in this range.'));
  const mcp = report.byTool.filter((t) => t.mcp);
  return frag(
    card(
      'Tool usage',
      `${int(report.totals.toolInvocations)} calls across ${int(report.totals.turns)} turns` +
        (mcp.length ? ` · ${int(mcp.length)} distinct MCP tools` : ''),
      barsH(report.byTool.slice(0, 15), {
        key: 'tool', value: 'count', format: int,
        colorFn: (r) => (r.mcp ? SERIES[6] : SERIES[0]),
        tipRows: (r) => [['Calls', int(r.count)], ['Share', pct(r.share)], ['MCP', r.mcp ? 'yes' : 'no']],
      }),
      el('div', { class: 'legend' }, [
        el('div', { class: 'item' }, [
          el('span', { class: 'swatch', style: `background:${SERIES[0]}` }),
          el('span', { text: 'Built-in' }),
        ]),
        el('div', { class: 'item' }, [
          el('span', { class: 'swatch', style: `background:${SERIES[6]}` }),
          el('span', { text: 'MCP server' }),
        ]),
      ]),
    ),
    card(
      'All tools',
      null,
      table(
        [{ label: 'Tool' }, { label: 'Calls', num: true }, { label: 'Share', num: true }],
        report.byTool.map((r) => [r.tool, int(r.count), pct(r.share)]),
        { scroll: true },
      ),
    ),
  );
}

/* ---------- sessions ---------- */

function sessions(report) {
  const wrap = el('div', { class: 'card' }, [el('h2', { text: 'Sessions' })]);
  wrap.appendChild(
    el('p', { class: 'hint', text: 'Most expensive first. Filter by project, branch, or session id.' }),
  );

  const search = el('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Filter sessions…',
    'aria-label': 'Filter sessions',
  });
  wrap.appendChild(search);

  const holder = el('div');
  wrap.appendChild(holder);

  const build = (q) => {
    const needle = q.trim().toLowerCase();
    const rows = report.sessions.filter(
      (s) =>
        !needle ||
        (s.project ?? '').toLowerCase().includes(needle) ||
        (s.branch ?? '').toLowerCase().includes(needle) ||
        (s.id ?? '').toLowerCase().includes(needle) ||
        (s.firstPrompt ?? '').toLowerCase().includes(needle),
    );
    holder.innerHTML = '';
    if (!rows.length) {
      holder.appendChild(note('No sessions match that filter.'));
      return;
    }
    holder.appendChild(
      table(
        [
          { label: 'Started' }, { label: 'Project', cls: 'mono truncate' },
          { label: 'Branch', cls: 'truncate' }, { label: 'Turns', num: true },
          { label: 'Duration', num: true }, { label: '$/hr', num: true }, { label: 'Cost', num: true },
        ],
        rows.slice(0, 300).map((s) => [
          s.start ? new Date(s.start).toLocaleString() : '—',
          shortPath(s.project),
          s.branch ?? '—',
          int(s.turns),
          dur(s.durationMs),
          s.costPerHour === null ? '—' : usd(s.costPerHour),
          usd(s.cost),
        ]),
        { scroll: true },
      ),
    );
    if (rows.length > 300) {
      holder.appendChild(el('p', { class: 'hint', text: `Showing the 300 most expensive of ${int(rows.length)}.` }));
    }
  };

  build('');
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => build(search.value), 120);
  });

  return frag(wrap);
}

export const PAGES = {
  overview: { label: 'Overview', render: overview },
  models: { label: 'Models', render: models },
  projects: { label: 'Projects', render: projects },
  activity: { label: 'Activity', render: activity },
  tools: { label: 'Tools', render: tools },
  sessions: { label: 'Sessions', render: sessions },
};
