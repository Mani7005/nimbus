import type { Execution } from "./execution";

export interface HistoryPage {
  executions: Execution[];
  nextCursor: string | null;
}

/** Appends an older page, skipping executions already listed (e.g. after a refresh raced with loading more). */
export function appendHistoryPage(current: readonly Execution[], page: readonly Execution[]): Execution[] {
  const listed = new Set(current.map((execution) => execution.id));
  return [...current, ...page.filter((execution) => !listed.has(execution.id))];
}
