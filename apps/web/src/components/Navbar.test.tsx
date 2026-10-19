import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LanguageId } from "../languages";
import Navbar from "./Navbar";

function render(running: boolean, language: LanguageId = "cpp"): string {
  return renderToStaticMarkup(
    <Navbar onRun={() => undefined} onLogout={() => undefined} user={null} running={running} language={language} onLanguageChange={() => undefined} />,
  );
}

function runButton(running: boolean): string {
  const html = render(running);
  const button = html.match(/<button[^>]*>(Run|Running\.\.\.)<\/button>/);
  if (!button) throw new Error(`Run button not found in ${html}`);
  return button[0];
}

function languageSelect(running: boolean, language?: LanguageId): string {
  const html = render(running, language);
  const select = html.match(/<select[^>]*>.*<\/select>/);
  if (!select) throw new Error(`Language select not found in ${html}`);
  return select[0];
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

describe("Navbar language select", () => {
  it("offers C++ and Java", () => {
    const options = [...languageSelect(false).matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map(([, value, label]) => ({ value, label }));
    expect(options).toEqual([
      { value: "cpp", label: "C++" },
      { value: "java", label: "Java" },
    ]);
  });

  it("marks the current language as selected", () => {
    expect(languageSelect(false, "java")).toMatch(/<option value="java" selected="">Java<\/option>/);
    expect(languageSelect(false, "java")).not.toMatch(/<option value="cpp" selected=""/);
    expect(languageSelect(false, "cpp")).toMatch(/<option value="cpp" selected="">C\+\+<\/option>/);
  });

  it("is disabled while an execution is in progress and enabled when idle", () => {
    expect(languageSelect(true)).toMatch(/^<select[^>]*\sdisabled=""/);
    expect(languageSelect(false)).not.toMatch(/^<select[^>]*\sdisabled=""/);
  });
});
