import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Navbar from "./Navbar";

function runButton(running: boolean): string {
  const html = renderToStaticMarkup(<Navbar onRun={() => undefined} onLogout={() => undefined} user={null} running={running} />);
  const button = html.match(/<button[^>]*>(Run|Running\.\.\.)<\/button>/);
  if (!button) throw new Error(`Run button not found in ${html}`);
  return button[0];
}

describe("Navbar Run button", () => {
  it("is disabled and says Running... while an execution is in progress", () => {
    const button = runButton(true);
    expect(button).toMatch(/\sdisabled=""/);
    expect(button).toContain(">Running...</button>");
  });

  it("is enabled when idle", () => {
    const button = runButton(false);
    // The attribute, not the Tailwind `disabled:` classes, which are always present.
    expect(button).not.toMatch(/\sdisabled=""/);
    expect(button).toContain(">Run</button>");
  });
});
