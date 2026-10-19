import { describe, expect, it, vi } from "vitest";
import type { Execution } from "./execution";
import { appendHistoryPage, restoreExecution } from "./history";

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

describe("restoreExecution", () => {
  const javaExecution: Execution = {
    ...ex("c9"),
    language: "java",
    code: "public class Main { public static void main(String[] a) { System.out.print(42); } }",
    input: "1 2",
    output: "42",
  };

  it("restores a Java execution's language with its code, input and output, even while C++ is selected", () => {
    expect(restoreExecution(javaExecution, "cpp")).toEqual({ language: "java", code: javaExecution.code, input: "1 2", output: "42" });
  });

  it("restores a C++ execution's language while Java is selected", () => {
    expect(restoreExecution({ ...ex("c8"), code: "int main() {}" }, "java").language).toBe("cpp");
  });

  it("keeps the current language for a language the editor does not offer", () => {
    for (const language of ["brainfuck", "constructor", "__proto__", "JAVA"]) {
      expect(restoreExecution({ ...javaExecution, language }, "java").language).toBe("java");
    }
  });

  it("uses the same placeholders as before for missing input and output", () => {
    expect(restoreExecution({ ...javaExecution, input: null, output: null }, "cpp")).toMatchObject({ input: "", output: "No Output" });
  });
});
