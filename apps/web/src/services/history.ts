import { isLanguageId, type LanguageId } from "../languages";
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

export interface RestoredExecution {
  language: LanguageId;
  code: string;
  input: string;
  output: string;
}

/**
 * Editor state for a selected history entry, including its language so the code is re-run as what it was written in.
 * A language the editor no longer offers (e.g. an old record) keeps the current selection.
 */
export function restoreExecution(execution: Execution, currentLanguage: LanguageId): RestoredExecution {
  return {
    language: isLanguageId(execution.language) ? execution.language : currentLanguage,
    code: execution.code,
    input: execution.input || "",
    output: execution.output || "No Output",
  };
}
