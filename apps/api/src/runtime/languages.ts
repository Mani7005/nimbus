/** Values accepted in Execution.language. Kept in sync with apps/web/src/languages.ts. */
export const SUPPORTED_LANGUAGES = ["cpp", "java"] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
