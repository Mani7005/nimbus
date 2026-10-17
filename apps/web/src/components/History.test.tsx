import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Execution } from "../services/execution";
import History from "./History";

const executions: Execution[] = [
  { id: "c1", language: "cpp", code: "", input: null, output: "42", status: "COMPLETED", createdAt: "2026-10-01T00:00:00Z", userId: "u" },
];

function render(hasMore: boolean, loadingMore = false, list = executions) {
  return renderToStaticMarkup(<History executions={list} onSelect={() => undefined} hasMore={hasMore} loadingMore={loadingMore} onLoadMore={() => undefined} />);
}

describe("History pagination", () => {
  it("offers Load more when older executions exist", () => {
    expect(render(true)).toMatch(/<button[^>]*>Load more<\/button>/);
  });

  it("disables the button and says Loading... while the next page loads", () => {
    const button = render(true, true).match(/<button[^>]*>Loading\.\.\.<\/button>/)?.[0] ?? "";
    expect(button).toMatch(/\sdisabled=""/);
  });

  it("hides the button on the last page and when there is no history", () => {
    expect(render(false)).not.toContain("Load more");
    expect(render(true, false, [])).toContain("No executions yet.");
    expect(render(true, false, [])).not.toContain("Load more");
  });
});
