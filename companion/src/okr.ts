const VOTING_HEADING = /^###\s*\[VOTING\]/;
const ANY_HEADING = /^###\s/;
const FENCE = /^```/;

/**
 * Extracts the `### [VOTING]` section from an assembly-transcript markdown
 * document (the shape produced by `print_llm_prompt()` / a live Anthropic
 * response following the assembly output format: `[OPENING]`, `[POSITIONS]`,
 * `[DEBATE]`, `[VOTING]`, `[NOTE]`).
 *
 * Runs from the `[VOTING]` heading line up to (but not including) the next
 * `###` heading, or to the end of the document if `[VOTING]` is the final
 * section. A `###`-looking line inside a fenced code block (```) is not
 * treated as a section boundary.
 *
 * Returns `''` when no `[VOTING]` heading is present. This is a pure
 * function -- callers own any whole-text fallback behavior.
 */
export function extractOkrs(assemblyMarkdown: string): string {
  const lines = assemblyMarkdown.split('\n');

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (VOTING_HEADING.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return '';

  let end = lines.length;
  let inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && ANY_HEADING.test(line)) {
      end = i;
      break;
    }
  }

  return lines.slice(start, end).join('\n').trim();
}
