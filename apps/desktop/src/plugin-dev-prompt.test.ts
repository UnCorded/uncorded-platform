import { describe, expect, test } from "bun:test";

import { AGENT_POINTER_PROMPT, buildAgentPrompt } from "./plugin-dev-prompt";

describe("buildAgentPrompt", () => {
  const prompt = buildAgentPrompt({
    slug: "trip-planner",
    displayName: "Trip Planner",
    description: "Plan trips together.",
    idea: "Members propose destinations, vote, and the winner gets a shared checklist.",
    pluginPath: "C:\\Users\\someone\\.uncorded\\plugin-dev\\trip-planner",
  });

  test("contains the idea verbatim", () => {
    expect(prompt).toContain(
      "Members propose destinations, vote, and the winner gets a shared checklist.",
    );
  });

  test("contains the plugin path and slug", () => {
    expect(prompt).toContain("C:\\Users\\someone\\.uncorded\\plugin-dev\\trip-planner");
    expect(prompt).toContain("trip-planner");
  });

  test("directs the agent to AGENTS.md before coding", () => {
    expect(prompt).toContain("AGENTS.md");
  });

  test("does not embed the full docs (AGENTS.md carries those)", () => {
    // Keep the clipboard payload readable; the docs bundle is ~65k chars.
    expect(prompt.length).toBeLessThan(5000);
  });
});

describe("AGENT_POINTER_PROMPT", () => {
  test("is command-line safe (letters, digits, spaces, commas, periods only)", () => {
    expect(AGENT_POINTER_PROMPT).toMatch(/^[A-Za-z0-9 .,]+$/);
  });

  test("points at PROMPT.md", () => {
    expect(AGENT_POINTER_PROMPT).toContain("PROMPT.md");
  });
});
