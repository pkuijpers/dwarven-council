import { describe, it, expect } from 'vitest';
import { extractOkrs } from '../src/okr.js';

/**
 * Synthetic markdown shaped like the real `assembly-response.md` fixture
 * that Task 8 will produce from a live Anthropic call -- that fixture
 * doesn't exist yet, so these mimic the documented output-format headings
 * from the assembly prompt: [OPENING], [POSITIONS], [DEBATE], [VOTING],
 * [NOTE].
 */
const fullAssembly = `### [OPENING]

The council convenes as winter grain stores dwindle.

### [POSITIONS]

- Producers: expand farm plots.
- Defenders: fortify the eastern wall.

### [DEBATE]

Delvers argue the ore vein takes priority over farmland.

### [VOTING]

**OKR 1: Secure the food supply**
- KR1: Plant 200 additional plump helmet spawn.
- KR2: Build 2 new food stockpiles.

**OKR 2: Harden defenses**
- KR1: Complete the eastern wall.

### [NOTE]

Minutes recorded by the Council scribe.
`;

describe('extractOkrs', () => {
  it('extracts the [VOTING] section from assembly-response.md-shaped input', () => {
    const result = extractOkrs(fullAssembly);
    expect(result.startsWith('### [VOTING]')).toBe(true);
    expect(result).toContain('Secure the food supply');
    expect(result).toContain('Harden defenses');
    expect(result).not.toContain('[NOTE]');
    expect(result).not.toContain('Minutes recorded');
    expect(result).not.toContain('[OPENING]');
    expect(result).not.toContain('[DEBATE]');
  });

  it('returns \'\' when there is no [VOTING] section', () => {
    const noVoting = `### [OPENING]\n\nThe council convenes.\n\n### [NOTE]\n\nNo vote taken this cycle.\n`;
    expect(extractOkrs(noVoting)).toBe('');
  });

  it('returns \'\' on an empty string', () => {
    expect(extractOkrs('')).toBe('');
  });

  it('[VOTING] as the final section runs to the end of the string', () => {
    const trailingVoting = `### [OPENING]

The council convenes.

### [VOTING]

**OKR 1: Stay alive**
- KR1: Don't starve.
`;
    const result = extractOkrs(trailingVoting);
    expect(result.startsWith('### [VOTING]')).toBe(true);
    expect(result).toContain("Don't starve.");
    expect(result.endsWith("Don't starve.")).toBe(true);
  });

  it('a ### inside a fenced code block does not terminate the section early', () => {
    const withFence = `### [OPENING]

The council convenes.

### [VOTING]

**OKR 1: Document the format**
- KR1: Show an example.

\`\`\`
### [NOT A REAL HEADING]
This looks like a heading but is inside a code fence.
\`\`\`

That fenced block is still part of the voting section.

### [NOTE]

Minutes recorded by the Council scribe.
`;
    const result = extractOkrs(withFence);
    expect(result.startsWith('### [VOTING]')).toBe(true);
    expect(result).toContain('### [NOT A REAL HEADING]');
    expect(result).toContain('That fenced block is still part of the voting section.');
    expect(result).not.toContain('[NOTE]');
    expect(result).not.toContain('Minutes recorded');
  });
});
