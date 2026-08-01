/**
 * Upload page: analyze transcripts that aren't in this machine's
 * ~/.claude/projects — a teammate's export, an archived run, a copy pulled off
 * a server.
 *
 * Files are read in the browser and POSTed to /api/analyze, which parses them
 * with the same server-side parser used for local scans. The dataset is held in
 * the server's memory only and is never written to disk.
 */

import { el, card, int } from './charts.js';

const MAX_TOTAL_BYTES = 250 * 1024 * 1024;

function bytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

export function uploadPage(report, { onAnalyzed }) {
  const frag = document.createDocumentFragment();

  const drop = el('div', { class: 'dropzone', tabindex: '0', role: 'button' }, [
    el('div', { class: 'drop-icon', text: '⤒' }),
    el('div', { class: 'drop-title', text: 'Drop .jsonl transcripts here' }),
    el('div', { class: 'drop-sub', text: 'or click to choose files — you can select a whole folder’s worth at once' }),
  ]);
  const input = el('input', { type: 'file', multiple: 'multiple', accept: '.jsonl,.json,application/json' });
  input.style.display = 'none';

  const status = el('div', { class: 'upload-status' });
  const fileList = el('div', { class: 'file-list' });

  function setStatus(text, kind = '') {
    status.innerHTML = '';
    if (text) status.appendChild(el('div', { class: `banner ${kind}`, text }));
  }

  async function handleFiles(fileArray) {
    const files = [...fileArray].filter((f) => /\.(jsonl|json)$/i.test(f.name));
    const rejected = fileArray.length - files.length;

    if (!files.length) {
      setStatus(
        rejected
          ? `None of those ${rejected} file(s) looked like transcripts. Expected .jsonl.`
          : 'No files selected.',
        'bad',
      );
      return;
    }

    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > MAX_TOTAL_BYTES) {
      setStatus(
        `That's ${bytes(total)} — over the ${bytes(MAX_TOTAL_BYTES)} limit. Upload fewer files at a time.`,
        'bad',
      );
      return;
    }

    fileList.innerHTML = '';
    for (const f of files) {
      fileList.appendChild(
        el('div', { class: 'file-row' }, [
          el('span', { class: 'mono truncate', text: f.name }),
          el('span', { class: 'muted', text: bytes(f.size) }),
        ]),
      );
    }

    setStatus(`Reading ${files.length} file(s), ${bytes(total)}…`);
    try {
      const payload = await Promise.all(
        files.map(async (f) => ({ name: f.name, text: await f.text() })),
      );
      setStatus('Analyzing…');
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files: payload }),
      });
      const body = await res.json();
      if (!res.ok) {
        setStatus(body.error ?? `Analysis failed (${res.status}).`, 'bad');
        return;
      }
      setStatus(
        `Analyzed ${int(body.turns)} turns across ${int(body.sessions)} session(s)` +
          (body.parseErrors ? ` · ${int(body.parseErrors)} unreadable lines skipped` : '') +
          ' — switching to the uploaded data.',
        'good',
      );
      onAnalyzed(body);
    } catch (err) {
      setStatus(`Could not analyze those files: ${err.message}`, 'bad');
    }
  }

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => handleFiles(input.files));
  for (const evt of ['dragenter', 'dragover']) {
    drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  for (const evt of ['dragleave', 'drop']) {
    drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  }
  drop.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });

  frag.appendChild(
    card(
      'Analyze uploaded transcripts',
      'For transcripts that live somewhere other than this machine’s ~/.claude/projects.',
      drop,
      input,
      status,
      fileList,
    ),
  );

  frag.appendChild(
    card(
      'What to upload',
      null,
      el('div', { class: 'prose' }, [
        el('p', {
          text:
            'Claude Code writes one .jsonl file per session under ~/.claude/projects/<encoded-project-path>/. ' +
            'Each line is a JSON object; assistant lines carry the token usage this dashboard costs. ' +
            'Upload any number of them — they do not have to come from the same project.',
        }),
        el('p', {
          text:
            'Uploaded transcripts are parsed by the same code path as a local scan, held in server memory, ' +
            'and never written to disk. Only the five most recent uploads are retained; restarting the ' +
            'server clears them.',
        }),
        el('p', {
          class: 'muted',
          text:
            'A file with no assistant entries carrying message.usage is rejected rather than shown as ' +
            'zero — that usually means it is not a Claude Code transcript.',
        }),
      ]),
    ),
  );

  if (report?.source?.uploaded) {
    frag.appendChild(
      card(
        'Currently viewing uploaded data',
        null,
        el('div', { class: 'prose' }, [
          el('p', { text: `Source: ${report.source.label}` }),
          el('p', {
            text:
              `${int(report.totals.turns)} turns · ${int(report.totals.sessions)} sessions · ` +
              `${int(report.totals.projects)} projects.`,
          }),
        ]),
      ),
    );
  }

  return frag;
}
