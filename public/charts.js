/**
 * Reusable presentation primitives: formatters, DOM/SVG helpers, the shared
 * tooltip, and the chart marks. Pages compose these; nothing here knows about
 * routing or data loading.
 */

const NS = 'http://www.w3.org/2000/svg';
export const SERIES = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
const SEQ = ['var(--seq-100)', 'var(--seq-250)', 'var(--seq-400)', 'var(--seq-550)', 'var(--seq-700)'];

const tooltip = document.getElementById('tooltip');

/* ---------- formatting ---------- */

export const usd = (n) => {
  if (n === 0) return '$0';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
};
export const tok = (n) => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
};
export const pct = (n) => `${(n * 100).toFixed(1)}%`;
export const int = (n) => Math.round(n).toLocaleString('en-US');
export const dur = (ms) => {
  if (!ms) return '—';
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
export const shortPath = (p) => {
  if (!p) return 'unknown';
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
};

/* ---------- DOM helpers ---------- */

export function el(tag, attrs = {}, children = []) {
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

export function card(title, hint, ...body) {
  const c = el('div', { class: 'card' }, [el('h2', { text: title })]);
  if (hint) c.appendChild(el('p', { class: 'hint', text: hint }));
  for (const b of body) if (b) c.appendChild(b);
  return c;
}

/* ---------- tooltip ---------- */

export function showTip(evt, title, rows) {
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

export function moveTip(evt) {
  const pad = 14;
  const r = tooltip.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
}

export const hideTip = () => { tooltip.style.opacity = '0'; };

/* ---------- charts ---------- */

/**
 * Daily cost over time: filled area under a 2px line, with a crosshair that
 * snaps to the nearest day.
 */
export function lineChart(daily) {
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
export function barsH(rows, { key, value, format = usd, colorFn, tipRows, width = 900 }) {
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
export function legend(rows, { key, value, format = usd, colorFn }) {
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
export function stackedBar(segments) {
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
export function heatmap(matrix, timeZone) {
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

/**
 * Scatter plot with a labelled point per row: x is price, y is capability.
 *
 * Point area — not radius — is proportional to `size`, so a dot that looks
 * twice as big really is twice the spend. Labels are placed to the right of
 * each dot and nudged when two points would collide.
 */
export function scatter(points, { x, y, size, label, colorFn, xFormat = usd, tipRows, xLabel, yLabel }) {
  const W = 900;
  const H = 360;
  const m = { top: 16, right: 24, bottom: 44, left: 56 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;

  // Both axes start at zero: a truncated price axis would exaggerate gaps
  // between models that are actually close together.
  const xMax = Math.max(...points.map((p) => p[x]), 1e-9) * 1.12;
  const yMax = Math.max(100, ...points.map((p) => p[y] ?? 0));
  const sizeMax = Math.max(...points.map((p) => p[size] ?? 0), 1e-9);
  const px = (v) => (v / xMax) * iw;
  const py = (v) => ih - (v / yMax) * ih;
  const radius = (v) => 5 + 13 * Math.sqrt(Math.max(0, v ?? 0) / sizeMax);

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': `${yLabel ?? 'capability'} against ${xLabel ?? 'price'}`,
  });
  const g = el('g', { transform: `translate(${m.left},${m.top})` });
  svg.appendChild(g);

  for (let i = 0; i <= 4; i += 1) {
    const v = (yMax / 4) * i;
    g.appendChild(el('line', { class: 'grid-line', x1: 0, x2: iw, y1: py(v), y2: py(v) }));
    g.appendChild(
      el('text', { class: 'axis-label', x: -10, y: py(v) + 4, 'text-anchor': 'end', text: Math.round(v) }),
    );
  }
  for (let i = 0; i <= 4; i += 1) {
    const v = (xMax / 4) * i;
    g.appendChild(
      el('text', { class: 'axis-label', x: px(v), y: ih + 18, 'text-anchor': 'middle', text: xFormat(v) }),
    );
  }
  g.appendChild(el('line', { class: 'axis-line', x1: 0, x2: iw, y1: ih, y2: ih }));
  g.appendChild(el('line', { class: 'axis-line', x1: 0, x2: 0, y1: 0, y2: ih }));
  if (xLabel) {
    g.appendChild(
      el('text', { class: 'axis-label', x: iw / 2, y: ih + 38, 'text-anchor': 'middle', text: xLabel }),
    );
  }
  if (yLabel) {
    g.appendChild(
      el('text', {
        class: 'axis-label',
        x: -(ih / 2),
        y: -40,
        transform: 'rotate(-90)',
        'text-anchor': 'middle',
        text: yLabel,
      }),
    );
  }

  // Draw the largest first so a small point never disappears behind a big one.
  const ordered = [...points].sort((a, b) => (b[size] ?? 0) - (a[size] ?? 0));
  const placed = [];
  for (const p of ordered) {
    const cx = px(p[x]);
    const cy = py(p[y] ?? 0);
    const r = radius(p[size]);
    const fill = colorFn ? colorFn(p) : SERIES[0];
    const node = el('g');
    node.appendChild(el('circle', { cx, cy, r, fill, 'fill-opacity': '0.75', stroke: fill, 'stroke-width': '1.5' }));

    // Nudge the label down when it would land on one already drawn.
    let ly = cy + 4;
    while (placed.some((q) => Math.abs(q.y - ly) < 12 && Math.abs(q.x - (cx + r + 7)) < 150)) ly += 13;
    placed.push({ x: cx + r + 7, y: ly });
    node.appendChild(
      el('text', {
        class: 'mark-label',
        x: cx + r + 7,
        y: ly,
        'text-anchor': cx + r + 90 > iw ? 'end' : 'start',
        ...(cx + r + 90 > iw ? { x: cx - r - 7 } : {}),
        text: String(p[label]),
      }),
    );

    const hit = el('circle', { cx, cy, r: Math.max(r, 10), fill: 'transparent' });
    hit.addEventListener('pointermove', (evt) => showTip(evt, String(p[label]), tipRows(p)));
    hit.addEventListener('pointerleave', hideTip);
    node.appendChild(hit);
    g.appendChild(node);
  }
  return svg;
}

/**
 * Checkbox filter rendered as a row of toggle chips.
 *
 * Chips rather than a <select multiple>: the options here are few, and a
 * multi-select listbox hides the current selection behind a scroll. Each chip
 * is a real checkbox, so keyboard and screen-reader behaviour comes for free.
 */
export function multiSelect(legendText, options, { selected, onChange, colorFn }) {
  const set = new Set(selected);
  const box = el('fieldset', { class: 'multi' });
  box.appendChild(el('legend', { text: legendText }));
  const chips = el('div', { class: 'chips' });

  const emit = () => onChange([...set]);
  for (const opt of options) {
    const input = el('input', { type: 'checkbox', value: opt.value });
    input.checked = set.has(opt.value);
    const chip = el('label', { class: `chip${input.checked ? ' on' : ''}` }, [input]);
    if (colorFn) {
      chip.appendChild(el('span', { class: 'dot', style: `background:${colorFn(opt)}` }));
    }
    chip.appendChild(el('span', { text: opt.label }));
    if (opt.note) chip.appendChild(el('span', { class: 'chip-note', text: opt.note }));
    input.addEventListener('change', () => {
      if (input.checked) set.add(opt.value);
      else set.delete(opt.value);
      chip.classList.toggle('on', input.checked);
      emit();
    });
    chips.appendChild(chip);
  }
  box.appendChild(chips);

  const actions = el('div', { class: 'chip-actions' });
  const all = el('button', { class: 'table-toggle', text: 'Select all' });
  all.addEventListener('click', () => {
    for (const opt of options) set.add(opt.value);
    for (const input of chips.querySelectorAll('input')) {
      input.checked = true;
      input.closest('.chip').classList.add('on');
    }
    emit();
  });
  const none = el('button', { class: 'table-toggle', text: 'Clear' });
  none.addEventListener('click', () => {
    set.clear();
    for (const input of chips.querySelectorAll('input')) {
      input.checked = false;
      input.closest('.chip').classList.remove('on');
    }
    emit();
  });
  actions.appendChild(all);
  actions.appendChild(none);
  box.appendChild(actions);
  return box;
}

/** Table view — the relief for sub-3:1 series colors, and the accessible fallback. */
export function table(head, rows, { scroll = false } = {}) {
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

export function collapsibleTable(label, node) {
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

