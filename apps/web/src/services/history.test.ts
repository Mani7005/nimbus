import { describe, expect, it, vi } from "vitest";
import type { Execution } from "./execution";
import { appendHistoryPage } from "./history";

const get = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ default: { get } }));

const { getExecutions } = await import("./execution");

const ex = (id: string): Execution => ({ id, language: "cpp", code: "", input: null, output: null, status: "COMPLETED", createdAt: "", userId: "u" });

describe("appendHistoryPage", () => {
  it("appends an older page after the current list", () => {
    expect(appendHistoryPage([ex("c3"), ex("c2")], [ex("c1"), ex("c0")]).map((e) => e.id)).toEqual(["c3", "c2", "c1", "c0"]);
  });

  it("skips executions that are already listed", () => {
    expect(appendHistoryPage([ex("c3"), ex("c2")], [ex("c2"), ex("c1")]).map((e) => e.id)).toEqual(["c3", "c2", "c1"]);
  });
});

describe("getExecutions", () => {
  it("requests the first page without a cursor and the next page with one", async () => {
    get.mockResolvedValue({ data: { success: true, executions: [], nextCursor: null } });

    await getExecutions();
    await getExecutions({ cursor: "cmrm5whp00000ieqonyoqlbge" });

    expect(get).toHaveBeenNthCalledWith(1, "/execute", { params: {} });
    expect(get).toHaveBeenNthCalledWith(2, "/execute", { params: { cursor: "cmrm5whp00000ieqonyoqlbge" } });
  });
});
