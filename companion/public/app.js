// Dwarven Companion -- single-page UI, no build step, no dependencies.
//
// Renders a status bar (connection, in-game date, next season), a "Current"
// tab showing the most recent cycle's adopted objectives, and a "History"
// tab listing every recorded cycle. Kept live via a Server-Sent Events
// connection to `/api/events`.

const SEASON_NAMES = ['Spring', 'Summer', 'Autumn', 'Winter'];

// ---------------------------------------------------------------------------
// Generic markdown rendering: a small renderer for the subset of markdown
// the briefing text uses (headings, **bold**, *italic*, `code`, "- "/"1. "
// lists, paragraphs, and a "---" horizontal rule) -- not a general-purpose
// markdown library.
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
}

/** Splits a "| a | b | c |" (or bare "a | b | c") row into trimmed cell strings. */
function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

/** A separator row like "|---|:---:|---|" -- dashes/colons only per cell, at least one dash. */
function isTableSeparatorRow(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function renderTable(headerLine, bodyLines) {
  const headerCells = splitTableRow(headerLine);
  const headerHtml = `<tr>${headerCells.map((c) => `<th>${renderInline(c)}</th>`).join('')}</tr>`;
  const bodyHtml = bodyLines
    .map((line) => `<tr>${splitTableRow(line).map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="table-wrap"><table><thead>${headerHtml}</thead><tbody>${bodyHtml}</tbody></table></div>`;
}

function renderMarkdown(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const blocks = [];
  let paragraph = [];
  let listItems = null;
  let listTag = 'ul';

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(`<p>${paragraph.join(' ')}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listItems) {
      blocks.push(`<${listTag}>${listItems.join('')}</${listTag}>`);
      listItems = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bulletItem = /^[-*]\s+(.*)$/.exec(line);
    const orderedItem = /^\d+\.\s+(.*)$/.exec(line);
    const isTableHeader = line.includes('|') && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1]);

    if (line === '') {
      flushParagraph();
      flushList();
    } else if (isTableHeader) {
      flushParagraph();
      flushList();
      const bodyLines = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() !== '' && lines[j].includes('|')) {
        bodyLines.push(lines[j]);
        j++;
      }
      blocks.push(renderTable(line, bodyLines));
      i = j - 1;
    } else if (/^-{3,}$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push('<hr>');
    } else if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
    } else if (bulletItem || orderedItem) {
      flushParagraph();
      const tag = bulletItem ? 'ul' : 'ol';
      if (listItems && listTag !== tag) flushList();
      listTag = tag;
      listItems = listItems ?? [];
      listItems.push(`<li>${renderInline((bulletItem ?? orderedItem)[1])}</li>`);
    } else {
      flushList();
      paragraph.push(renderInline(line));
    }
  }
  flushParagraph();
  flushList();
  return blocks.join('\n');
}

// ---------------------------------------------------------------------------
// Assembly transcript rendering: the assembly text follows a fixed format
// (see companion/src/prompt.ts's buildSystemPrompt "Output Format"):
// "### [TAG] Title" sections, with the "[VOTING]" section containing
// "#### Motion N: title" blocks. This renders that structure directly
// instead of generic markdown, falling back to renderMarkdown for any
// section (or the whole document) that doesn't match.
// ---------------------------------------------------------------------------

const SECTION_HEADING = /^###\s*\[([A-Z]+)\]\s*(.*)$/;
const MOTION_HEADING = /^####\s*Motion\s*\d+:\s*(.*)$/i;
const KR_ITEM = /^[-*]\s*(?:KR\d+\s*:\s*)?(.*)$/i;
const VOTE_LINE = /^[-*]\s*(For|Against|Abstain)\s*:\s*(.*)$/i;
const RESULT_LINE = /\[(PASS|FAIL)\]/;

const SECTION_LABELS = {
  OPENING: 'Opening',
  POSITIONS: 'Positions',
  DEBATE: 'Debate',
  VOTING: 'Voting',
  NOTE: 'Notes',
};

/** Splits assembly markdown into `{ tag, title, body }` sections on "### [TAG] Title" headings. */
function splitSections(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const sections = [];
  let current = null;

  for (const line of lines) {
    const match = SECTION_HEADING.exec(line.trim());
    if (match) {
      current = { tag: match[1], title: match[2], bodyLines: [] };
      sections.push(current);
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  return sections;
}

/** Parses "#### Motion N: title" blocks out of a VOTING section's body lines. Returns [] if none match. */
function parseMotions(bodyLines) {
  const motions = [];
  let current = null;

  const flush = () => {
    if (current) motions.push(current);
    current = null;
  };

  for (const rawLine of bodyLines) {
    const line = rawLine.trim();
    // Vote lines are emitted as "- **For: 34** (...)" -- the bold markers sit
    // *inside* the bullet, wrapping the whole "Label: N" span, so matching
    // against the raw line would miss them (the label isn't the first thing
    // after the bullet, "**" is). Stripping "**" first lets VOTE_LINE match
    // regardless of where the assembly happened to place the bold markers.
    const strippedLine = line.replace(/\*\*/g, '');
    const motionMatch = MOTION_HEADING.exec(line);
    const voteMatch = VOTE_LINE.exec(strippedLine);
    const resultMatch = RESULT_LINE.exec(line);

    if (motionMatch) {
      flush();
      current = { title: motionMatch[1], submittedBy: '', krs: [], votes: {}, result: null };
    } else if (!current) {
      continue;
    } else if (/^-{3,}$/.test(line)) {
      // Horizontal rule between motions -- not content.
    } else if (/^submitted by:/i.test(line)) {
      current.submittedBy = line.replace(/^submitted by:\s*/i, '');
    } else if (resultMatch) {
      current.result = resultMatch[1] === 'PASS' ? 'pass' : 'fail';
    } else if (voteMatch) {
      current.votes[voteMatch[1].toLowerCase()] = voteMatch[2];
    } else if (
      KR_ITEM.test(line) &&
      /^[-*]/.test(line) &&
      !/^\*\*/.test(line) &&
      // A whole line wrapped in single asterisks is an italic aside (e.g.
      // "*Urist: ...*"), not a bulleted KR -- "*" here is emphasis, not a
      // list marker.
      !/^\*[^*].*\*$/.test(line)
    ) {
      current.krs.push(KR_ITEM.exec(line)[1]);
    }
  }
  flush();
  return motions;
}

function motionVoteRow(motion) {
  const parts = [];
  if (motion.votes.for) parts.push(`<span>For: ${escapeHtml(motion.votes.for)}</span>`);
  if (motion.votes.against) parts.push(`<span>Against: ${escapeHtml(motion.votes.against)}</span>`);
  if (motion.votes.abstain) parts.push(`<span>Abstain: ${escapeHtml(motion.votes.abstain)}</span>`);
  if (motion.result) {
    const label = motion.result === 'pass' ? 'Adopted' : 'Rejected';
    parts.push(`<span class="vote-badge vote-badge--${motion.result}">${label}</span>`);
  }
  return parts.length > 0 ? `<div class="motion__vote-row">${parts.join('')}</div>` : '';
}

function renderMotion(motion) {
  const meta = motion.submittedBy ? `<div class="motion__meta">Submitted by: ${renderInline(motion.submittedBy)}</div>` : '';
  const krs = motion.krs.map((kr) => `<div class="motion__kr">${renderInline(kr)}</div>`).join('');
  return (
    `<div class="motion">` +
    `<div class="motion__title">${renderInline(motion.title)}</div>` +
    meta +
    krs +
    motionVoteRow(motion) +
    `</div>`
  );
}

/** Renders the full assembly transcript, falling back to generic markdown wherever the fixed format isn't found. */
function renderAssembly(markdown) {
  const sections = splitSections(markdown);
  if (sections.length === 0) return renderMarkdown(markdown);

  return sections
    .map((section) => {
      const label = SECTION_LABELS[section.tag] ?? section.title ?? section.tag;
      const body = section.bodyLines.join('\n');
      const motions = section.tag === 'VOTING' ? parseMotions(section.bodyLines) : [];
      const bodyHtml = motions.length > 0 ? motions.map(renderMotion).join('') : renderMarkdown(body);
      return (
        `<div class="assembly-section">` +
        `<div class="assembly-section__label">${escapeHtml(label)}</div>` +
        bodyHtml +
        `</div>`
      );
    })
    .join('');
}

/** Adopted (or unscored) objectives from a cycle's extracted `okrs` VOTING text, for the compact/hero views. */
function adoptedMotions(okrsText) {
  if (!okrsText) return [];
  const motions = parseMotions(String(okrsText).split('\n'));
  return motions.filter((m) => m.result !== 'fail');
}

function renderOkrList(motions, compact) {
  const listClass = compact ? 'okr-list okr-list--compact' : 'okr-list';
  const items = motions.map((m) => {
    const krs = !compact && m.krs.length > 0
      ? `<div class="okr-item__krs">${m.krs.map((kr) => `<div class="okr-item__kr">${renderInline(kr)}</div>`).join('')}</div>`
      : '';
    return `<div class="okr-item"><span class="okr-item__mark">&#10022;</span><div><div>${renderInline(m.title)}</div>${krs}</div></div>`;
  }).join('');
  return `<div class="${listClass}">${items}</div>`;
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

const connectionEl = document.getElementById('status-connection');
const dateEl = document.getElementById('status-date');
const nextSeasonEl = document.getElementById('status-next-season');
const errorEl = document.getElementById('status-error');
const triggerButton = document.getElementById('trigger-now');
const progressBannerEl = document.getElementById('progress-banner');
const progressTimerEl = document.getElementById('progress-banner-timer');

/** Interval driving the progress banner's elapsed-time readout; only runs while a cycle is in flight. */
let progressTimerHandle = null;

function formatElapsed(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins > 0 ? `${mins}m ${secs}s elapsed` : `${secs}s elapsed`;
}

function updateProgressBanner(cycleStartedAt) {
  if (!cycleStartedAt) {
    progressBannerEl.hidden = true;
    if (progressTimerHandle) {
      clearInterval(progressTimerHandle);
      progressTimerHandle = null;
    }
    return;
  }

  progressBannerEl.hidden = false;
  progressTimerEl.textContent = formatElapsed(cycleStartedAt);
  if (!progressTimerHandle) {
    progressTimerHandle = setInterval(() => {
      progressTimerEl.textContent = formatElapsed(cycleStartedAt);
    }, 1000);
  }
}

function renderStatus(status) {
  if (status.connected && status.fortressLoaded) {
    connectionEl.textContent = 'Connected';
    connectionEl.className = 'status-pill status-pill--connected';
  } else if (status.connected) {
    connectionEl.textContent = 'No fortress loaded';
    connectionEl.className = 'status-pill status-pill--disconnected';
  } else {
    connectionEl.textContent = 'Disconnected';
    connectionEl.className = 'status-pill status-pill--disconnected';
  }

  if (status.date) {
    const { year, seasonName, seasonIndex } = status.date;
    dateEl.textContent = `${seasonName}, Year ${year}`;
    const nextIndex = (seasonIndex + 1) % SEASON_NAMES.length;
    const nextYear = nextIndex === 0 ? year + 1 : year;
    nextSeasonEl.textContent = `Next season: ${SEASON_NAMES[nextIndex]}, Year ${nextYear}`;
  } else {
    dateEl.textContent = 'Date: —';
    nextSeasonEl.textContent = 'Next season: —';
  }

  updateProgressBanner(status.cycleStartedAt);
  if (status.lastError) {
    errorEl.hidden = false;
    errorEl.textContent = `Last error: ${status.lastError}`;
  } else {
    errorEl.hidden = true;
  }

  triggerButton.disabled = Boolean(status.cycleRunning);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const tabButtons = document.querySelectorAll('.tab');
const panes = {
  current: document.getElementById('pane-current'),
  history: document.getElementById('pane-history'),
};

function setActiveTab(name) {
  for (const button of tabButtons) {
    const active = button.dataset.tab === name;
    button.classList.toggle('tab--active', active);
    button.setAttribute('aria-selected', String(active));
  }
  for (const [key, pane] of Object.entries(panes)) {
    pane.classList.toggle('pane--active', key === name);
  }
}

for (const button of tabButtons) {
  button.addEventListener('click', () => setActiveTab(button.dataset.tab));
}

// ---------------------------------------------------------------------------
// Current tab
// ---------------------------------------------------------------------------

const currentPaneEl = document.getElementById('pane-current');
const currentEmptyEl = document.getElementById('current-empty');

function renderCurrentPane(cycle) {
  currentPaneEl.querySelectorAll('.okr-hero, .current-report').forEach((el) => el.remove());
  currentEmptyEl.hidden = Boolean(cycle);
  if (!cycle) return;

  const hero = document.createElement('div');
  hero.className = 'okr-hero';

  if (cycle.status === 'failed') {
    hero.innerHTML =
      `<div class="okr-hero__label">&#9888; Assembly failed — ${escapeHtml(cycle.seasonName)} ${cycle.year}</div>` +
      `<p class="history-card__error">${escapeHtml(cycle.error ?? 'Unknown error')}</p>`;
  } else {
    const motions = adoptedMotions(cycle.okrs);
    const body =
      motions.length > 0
        ? renderOkrList(motions, false)
        : '<p class="okr-empty">No objectives were adopted this quarter.</p>';
    hero.innerHTML = `<div class="okr-hero__label">&#9873; Objectives — ${escapeHtml(cycle.seasonName)} ${cycle.year}</div>${body}`;
  }

  currentPaneEl.appendChild(hero);

  if (cycle.assembly) {
    const report = document.createElement('div');
    report.className = 'current-report';
    report.innerHTML =
      `<div class="current-report__label">Assembly report — ${escapeHtml(cycle.seasonName)} ${cycle.year}</div>` +
      `<div class="markdown">${renderAssembly(cycle.assembly)}</div>`;
    currentPaneEl.appendChild(report);
  }
}

// ---------------------------------------------------------------------------
// History tab
// ---------------------------------------------------------------------------

const historyListEl = document.getElementById('history-list');
const historyEmptyEl = document.getElementById('history-empty');

/** All known cycles, keyed by id, so SSE cycle events can replace/insert in place. */
const cyclesById = new Map();

function historyCard(cycle) {
  const card = document.createElement('article');
  card.className = 'history-card';
  card.dataset.cycleId = cycle.id;

  const header = document.createElement('div');
  header.className = 'history-card__header';

  const title = document.createElement('h2');
  title.className = 'history-card__title';
  title.textContent = `${cycle.seasonName} ${cycle.year}`;
  header.appendChild(title);

  const statusBadge = document.createElement('span');
  statusBadge.className = `history-card__status history-card__status--${cycle.status}`;
  statusBadge.textContent = cycle.status;
  header.appendChild(statusBadge);

  const timestamp = document.createElement('span');
  timestamp.className = 'history-card__timestamp';
  timestamp.textContent = new Date(cycle.triggeredAt).toLocaleString();
  header.appendChild(timestamp);

  card.appendChild(header);

  if (cycle.status === 'failed') {
    const errorPara = document.createElement('p');
    errorPara.className = 'history-card__error';
    errorPara.textContent = cycle.error ?? 'Unknown error';
    card.appendChild(errorPara);
  } else {
    const motions = adoptedMotions(cycle.okrs);
    const summary = document.createElement('div');
    summary.innerHTML =
      motions.length > 0
        ? renderOkrList(motions, true)
        : '<p class="okr-empty">No objectives were adopted this quarter.</p>';
    card.appendChild(summary.firstChild ?? summary);
  }

  card.appendChild(detailsBlock('Briefing', () => renderMarkdown(cycle.briefing)));
  if (cycle.assembly) {
    card.appendChild(detailsBlock('Assembly', () => renderAssembly(cycle.assembly)));
  }

  return card;
}

function detailsBlock(label, renderBody) {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = label;
  details.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'markdown';
  body.innerHTML = renderBody();
  details.appendChild(body);
  return details;
}

function sortedCycles() {
  return [...cyclesById.values()].sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt));
}

function renderHistoryList() {
  const cycles = sortedCycles();
  historyEmptyEl.hidden = cycles.length > 0;

  historyListEl.querySelectorAll('.history-card').forEach((el) => el.remove());
  for (const cycle of cycles) {
    historyListEl.appendChild(historyCard(cycle));
  }
}

function renderAll() {
  const cycles = sortedCycles();
  renderCurrentPane(cycles[0]);
  renderHistoryList();
}

function upsertCycle(cycle) {
  cyclesById.set(cycle.id, cycle);
  renderAll();
}

// ---------------------------------------------------------------------------
// Data loading + live updates
// ---------------------------------------------------------------------------

async function loadInitialData() {
  try {
    const [statusRes, historyRes] = await Promise.all([fetch('/api/status'), fetch('/api/history')]);
    renderStatus(await statusRes.json());
    const history = await historyRes.json();
    for (const cycle of history) {
      cyclesById.set(cycle.id, cycle);
    }
    renderAll();
  } catch (err) {
    connectionEl.textContent = 'Disconnected';
    connectionEl.className = 'status-pill status-pill--disconnected';
    console.error('Failed to load initial data', err);
  }
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('status', (event) => {
    renderStatus(JSON.parse(event.data));
  });
  source.addEventListener('cycle', (event) => {
    upsertCycle(JSON.parse(event.data));
  });
  source.addEventListener('error', () => {
    // EventSource auto-reconnects; just reflect the drop while it does.
    connectionEl.textContent = 'Disconnected';
    connectionEl.className = 'status-pill status-pill--disconnected';
  });
}

triggerButton.addEventListener('click', async () => {
  triggerButton.disabled = true;
  errorEl.hidden = true;
  try {
    const res = await fetch('/api/cycle', { method: 'POST' });
    if (res.ok) {
      upsertCycle(await res.json());
    } else if (res.status !== 409) {
      const body = await res.json().catch(() => ({}));
      errorEl.hidden = false;
      errorEl.textContent = `Failed to trigger assembly: ${body.error ?? res.status}`;
    }
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = `Failed to trigger assembly: ${err}`;
  } finally {
    triggerButton.disabled = false;
  }
});

loadInitialData();
connectEvents();
