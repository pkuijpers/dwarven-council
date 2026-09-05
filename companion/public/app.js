// Dwarven Companion -- single-page UI, no build step, no dependencies.
//
// Renders a status bar (connection, in-game date, next season) and a
// reverse-chronological list of assembly cycles fetched from `/api/history`,
// kept live via a Server-Sent Events connection to `/api/events`.

const SEASON_NAMES = ['Spring', 'Summer', 'Autumn', 'Winter'];

// ---------------------------------------------------------------------------
// Markdown rendering: a small renderer for the subset of markdown the
// companion actually produces (headings, **bold**, "- " lists, paragraphs,
// and a "---" horizontal rule) -- not a general-purpose markdown library.
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
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function renderMarkdown(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const blocks = [];
  let paragraph = [];
  let listItems = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(`<p>${paragraph.join(' ')}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listItems) {
      blocks.push(`<ul>${listItems.join('')}</ul>`);
      listItems = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const listItem = /^-\s+(.*)$/.exec(line);

    if (line === '') {
      flushParagraph();
      flushList();
    } else if (/^-{3,}$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push('<hr>');
    } else if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
    } else if (listItem) {
      flushParagraph();
      listItems = listItems ?? [];
      listItems.push(`<li>${renderInline(listItem[1])}</li>`);
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
// Status bar
// ---------------------------------------------------------------------------

const connectionEl = document.getElementById('status-connection');
const dateEl = document.getElementById('status-date');
const nextSeasonEl = document.getElementById('status-next-season');
const cycleEl = document.getElementById('status-cycle');
const errorEl = document.getElementById('status-error');
const triggerButton = document.getElementById('trigger-now');

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

  cycleEl.hidden = !status.cycleRunning;
  if (status.lastError) {
    errorEl.hidden = false;
    errorEl.textContent = `Last error: ${status.lastError}`;
  } else {
    errorEl.hidden = true;
  }

  triggerButton.disabled = Boolean(status.cycleRunning);
}

// ---------------------------------------------------------------------------
// Assembly list
// ---------------------------------------------------------------------------

const listEl = document.getElementById('assembly-list');
const emptyEl = document.getElementById('assembly-list-empty');

/** All known cycles, keyed by id, so SSE cycle events can replace/insert in place. */
const cyclesById = new Map();

function cycleCard(cycle) {
  const card = document.createElement('article');
  card.className = 'assembly-card';
  card.dataset.cycleId = cycle.id;

  const header = document.createElement('div');
  header.className = 'assembly-card__header';

  const title = document.createElement('h2');
  title.className = 'assembly-card__title';
  title.textContent = `${cycle.seasonName} ${cycle.year}`;
  header.appendChild(title);

  const statusBadge = document.createElement('span');
  statusBadge.className = `assembly-card__status assembly-card__status--${cycle.status}`;
  statusBadge.textContent = cycle.status;
  header.appendChild(statusBadge);

  const timestamp = document.createElement('span');
  timestamp.className = 'assembly-card__timestamp';
  timestamp.textContent = new Date(cycle.triggeredAt).toLocaleString();
  header.appendChild(timestamp);

  card.appendChild(header);

  if (cycle.status === 'failed' && cycle.error) {
    const errorPara = document.createElement('p');
    errorPara.className = 'assembly-card__error';
    errorPara.textContent = cycle.error;
    card.appendChild(errorPara);
  }

  card.appendChild(markdownDetails('Briefing', cycle.briefing, true));
  if (cycle.assembly) {
    card.appendChild(markdownDetails('Assembly', cycle.assembly, false));
  }

  return card;
}

function markdownDetails(label, markdown, open) {
  const details = document.createElement('details');
  details.open = open;
  const summary = document.createElement('summary');
  summary.textContent = label;
  details.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'markdown';
  body.innerHTML = renderMarkdown(markdown);
  details.appendChild(body);
  return details;
}

function renderList() {
  const cycles = [...cyclesById.values()].sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt));
  emptyEl.hidden = cycles.length > 0;

  listEl.querySelectorAll('.assembly-card').forEach((el) => el.remove());
  for (const cycle of cycles) {
    listEl.appendChild(cycleCard(cycle));
  }
}

function upsertCycle(cycle) {
  cyclesById.set(cycle.id, cycle);
  renderList();
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
    renderList();
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
