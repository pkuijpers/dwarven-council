// eval-grounding.mjs
//
// Prints a cycle's numeric "facts sheet" (from state) next to its
// generated OKR/narrative text, so a human or Claude Code can judge
// consistency without wading through the raw history.json tree.
//
// Requires `npm run build` (in companion/) to have been run at least
// once -- this imports the compiled dist output, like the rest of the
// companion app.
//
// Usage: node companion/scripts/eval-grounding.mjs [--id <cycleId>] [--all] [--full] [--history <path>]

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HistoryStore } from '../dist/history.js';
import { formatCycleReport } from '../dist/eval-grounding.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opts = { id: undefined, all: false, full: false, historyPath: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--id') {
      opts.id = argv[++i];
    } else if (arg === '--all') {
      opts.all = true;
    } else if (arg === '--full') {
      opts.full = true;
    } else if (arg === '--history') {
      opts.historyPath = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const historyPath = opts.historyPath ?? join(__dirname, '..', 'data', 'history.json');
  const store = new HistoryStore(historyPath);
  const cycles = await store.load();

  if (cycles.length === 0) {
    console.error(`No cycles recorded yet in ${historyPath}.`);
    process.exitCode = 1;
    return;
  }

  const targets = [];
  if (opts.all) {
    targets.push(...cycles);
  } else if (opts.id) {
    const match = cycles.find((c) => c.id === opts.id);
    if (!match) {
      console.error(
        `No cycle with id "${opts.id}". Available ids: ${cycles.map((c) => c.id).join(', ')}`
      );
      process.exitCode = 1;
      return;
    }
    targets.push(match);
  } else {
    const completed = cycles.filter((c) => c.status === 'completed');
    if (completed.length === 0) {
      console.error(`No completed cycles in ${historyPath} yet (all recorded cycles failed).`);
      process.exitCode = 1;
      return;
    }
    targets.push(completed[completed.length - 1]);
  }

  for (const cycle of targets) {
    console.log(formatCycleReport(cycle, { full: opts.full }));
    console.log('');
  }
}

main().catch((err) => {
  console.error('eval-grounding failed:', err);
  process.exitCode = 1;
});
