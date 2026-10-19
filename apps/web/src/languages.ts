export interface LanguageDefinition {
  /** Value sent to and stored by the API; must match SUPPORTED_LANGUAGES in apps/api/src/runtime/languages.ts. */
  id: string;
  label: string;
  /** Monaco editor language id. */
  monacoLanguage: string;
  starterCode: string;
}

export const LANGUAGES = [
  {
    id: "cpp",
    label: "C++",
    monacoLanguage: "cpp",
    starterCode: `#include<iostream>
using namespace std;

int main() {
    cout << "Hello Nimbus";
    return 0;
}`,
  },
  {
    id: "java",
    label: "Java",
    monacoLanguage: "java",
    starterCode: `public class Main {
    public static void main(String[] args) {
        System.out.println("Hello Nimbus");
    }
}`,
  },
] as const satisfies readonly LanguageDefinition[];

export type LanguageId = (typeof LANGUAGES)[number]["id"];

export const DEFAULT_LANGUAGE: LanguageId = "cpp";

export function isLanguageId(value: string): value is LanguageId {
  return LANGUAGES.some((language) => language.id === value);
}

export function getLanguage(id: LanguageId): LanguageDefinition {
  return LANGUAGES.find((language) => language.id === id) ?? LANGUAGES[0];
}

/**
 * The editor contents after switching languages: the new language's starter code if the editor is empty or still
 * holds the previous language's untouched starter code, otherwise the user's code unchanged.
 */
export function codeAfterLanguageChange(code: string, from: LanguageId, to: LanguageId): string {
  const untouched = code.trim() === "" || code === getLanguage(from).starterCode;
  return untouched ? getLanguage(to).starterCode : code;
}
