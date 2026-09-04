import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractPayload, type AssemblyPayload } from '../src/payload.js';
import {
  pct,
  calculateHappiness,
  buildSystemPrompt,
  buildUserPrompt,
} from '../src/prompt.js';
import { FACTION_NARRATIVES } from '../src/factions.js';
import type { PopulationStress } from '../src/types.js';

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const zeroStress: PopulationStress = {
  joyous: 0,
  happy: 0,
  content: 0,
  fine: 0,
  unhappy: 0,
  stressed: 0,
  miserable: 0,
};

describe('prompt port', () => {
  // Hoisted out of the individual `it()` blocks -- the brief's example
  // declared `payload` with `const` inside the first `it()` and then reused
  // the bare name in sibling `it()` blocks, which is out of scope and would
  // not compile. Loading the fixture once in `beforeAll` and sharing it via
  // a describe-level `let` fixes that while keeping the single-parse intent.
  let payload: AssemblyPayload;

  beforeAll(() => {
    payload = extractPayload(
      readFileSync(fixturePath('raw-assembly-output.txt'), 'utf8')
    );
  });

  it('reproduces the legacy Lua prompt byte for byte', () => {
    // The deleted `print_llm_prompt(system_prompt, user_prompt)` was:
    //   print(system_prompt .. "\n\n" .. user_prompt)
    // Lua's `print` always appends a trailing "\n" to what it writes, and
    // legacy-prompt.txt was captured from that real stdout (banner
    // stripped) -- confirmed by inspecting its raw bytes, which end
    // "...voting.\n" with no second blank line. Neither build_system_prompt
    // nor build_user_prompt appends a trailing newline itself (checked
    // against the pre-deletion Lua source), so that final "\n" belongs to
    // the print step, not to either pure builder -- it's added here rather
    // than inside buildSystemPrompt/buildUserPrompt.
    const combined =
      buildSystemPrompt(payload.state) +
      '\n\n' +
      buildUserPrompt(payload.state, payload.briefing) +
      '\n';
    expect(combined).toBe(readFileSync(fixturePath('legacy-prompt.txt'), 'utf8'));
  });

  it('puts exactly one newline between the faction list and the procedure heading', () => {
    const sys = buildSystemPrompt(payload.state);
    expect(sys).toMatch(/Priorities: [^\n]+\n## Assembly Procedure/);
  });

  it('keeps the two trailing spaces on the KR2 line', () => {
    expect(buildSystemPrompt(payload.state)).toContain(
      '- KR2: [Measurable key result]  \n'
    );
  });

  it('covers every faction the game reports', () => {
    for (const id of Object.keys(payload.state.population.factions)) {
      expect(FACTION_NARRATIVES).toHaveProperty(id);
    }
  });
});

describe('pct', () => {
  it('returns "0%" when total is 0', () => {
    expect(pct(0, 0)).toBe('0%');
    expect(pct(5, 0)).toBe('0%');
  });

  it('floors to an integer percentage (not one decimal)', () => {
    expect(pct(9, 40)).toBe('22%');
    expect(pct(1, 40)).toBe('2%');
  });
});

describe('calculateHappiness', () => {
  it('returns 50 for an all-zero stress table (avoids divide-by-zero)', () => {
    expect(calculateHappiness(zeroStress)).toBe(50);
  });

  it('weights joyous/happy/content/fine/unhappy/stressed but not miserable in the numerator', () => {
    // total = 1 (miserable), weighted numerator = 0 -> floor(0/1) = 0
    expect(calculateHappiness({ ...zeroStress, miserable: 1 })).toBe(0);
  });

  it('matches a known mixed distribution', () => {
    // joyous*100 + happy*85 + content*70 + fine*50 + unhappy*30 + stressed*15
    // = 1*100 + 1*85 + 1*70 = 255; total = 3 -> floor(255/3) = 85
    const stress: PopulationStress = {
      ...zeroStress,
      joyous: 1,
      happy: 1,
      content: 1,
    };
    expect(calculateHappiness(stress)).toBe(85);
  });
});

describe('buildSystemPrompt', () => {
  it('omits factions with members === 0', () => {
    const payload = extractPayload(
      readFileSync(fixturePath('raw-assembly-output.txt'), 'utf8')
    );
    const state = structuredClone(payload.state);
    const factions = state.population.factions as Record<
      string,
      { members: number; name: string; votes: number }
    >;
    factions.delvers = { ...factions.delvers, members: 0 };
    const sys = buildSystemPrompt(state);
    expect(sys).not.toContain('Delvers Guild');
  });
});

describe('buildUserPrompt focus areas', () => {
  async function loadState() {
    const payload = extractPayload(
      readFileSync(fixturePath('raw-assembly-output.txt'), 'utf8')
    );
    return structuredClone(payload.state);
  }

  it('includes "Morale improvement" only when happiness < 50', async () => {
    const state = await loadState();
    state.population.stress = { ...zeroStress, miserable: 100 }; // happiness 0
    const prompt = buildUserPrompt(state, 'briefing');
    expect(prompt).toContain('Morale improvement');
  });

  it('excludes "Morale improvement" when happiness >= 50', async () => {
    const state = await loadState();
    state.population.stress = { ...zeroStress, joyous: 100 }; // happiness 100
    const prompt = buildUserPrompt(state, 'briefing');
    expect(prompt).not.toContain('Morale improvement');
  });

  it('includes "Food production" when food status is low or critical', async () => {
    const state = await loadState();
    state.resources.food.status = 'low';
    expect(buildUserPrompt(state, 'briefing')).toContain('Food production');
    state.resources.food.status = 'critical';
    expect(buildUserPrompt(state, 'briefing')).toContain('Food production');
  });

  it('excludes "Food production" when food status is adequate/abundant', async () => {
    const state = await loadState();
    state.resources.food.status = 'abundant';
    expect(buildUserPrompt(state, 'briefing')).not.toContain('Food production');
  });

  it('includes "Alcohol production" when drink status is low or critical', async () => {
    const state = await loadState();
    state.resources.drink.status = 'critical';
    expect(buildUserPrompt(state, 'briefing')).toContain('Alcohol production');
  });

  it('includes "Collective defense" when military < total / 10', async () => {
    const state = await loadState();
    state.population.military = 1;
    state.population.total = 100;
    expect(buildUserPrompt(state, 'briefing')).toContain('Collective defense');
  });

  it('excludes "Collective defense" when military >= total / 10', async () => {
    const state = await loadState();
    state.population.military = 20;
    state.population.total = 100;
    expect(buildUserPrompt(state, 'briefing')).not.toContain('Collective defense');
  });

  it('always includes "Wealth building" and "Infrastructure" in that order at the end', async () => {
    const state = await loadState();
    const prompt = buildUserPrompt(state, 'briefing');
    expect(prompt).toContain('Wealth building, Infrastructure');
  });

  it('computes available workforce as adults - military - injured, and can go negative', async () => {
    const state = await loadState();
    state.population.adults = 10;
    state.population.military = 8;
    state.population.injured = 5; // 10 - 8 - 5 = -3
    const prompt = buildUserPrompt(state, 'briefing');
    expect(prompt).toContain('Available workforce: -3 dwarves');
  });

  it('computes quorum as floor(eligible_voters / 2) + 1', async () => {
    const state = await loadState();
    state.population.eligible_voters = 40;
    const prompt = buildUserPrompt(state, 'briefing');
    expect(prompt).toContain('Quorum: 21 votes');
  });
});
