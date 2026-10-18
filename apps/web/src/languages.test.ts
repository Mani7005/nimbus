import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES } from "../../api/src/runtime/languages";
import { DEFAULT_LANGUAGE, LANGUAGES, codeAfterLanguageChange, getLanguage, isLanguageId } from "./languages";

describe("language metadata", () => {
  it("offers exactly the languages the API accepts, in the same order", () => {
    expect(LANGUAGES.map((language) => language.id)).toEqual([...SUPPORTED_LANGUAGES]);
  });

  it("maps each language to its label and Monaco language", () => {
    expect(LANGUAGES.map(({ id, label, monacoLanguage }) => ({ id, label, monacoLanguage }))).toEqual([
      { id: "cpp", label: "C++", monacoLanguage: "cpp" },
      { id: "java", label: "Java", monacoLanguage: "java" },
    ]);
  });

  it("defaults to C++ with the existing starter program", () => {
    expect(DEFAULT_LANGUAGE).toBe("cpp");
    expect(getLanguage("cpp").starterCode).toBe('#include<iostream>\nusing namespace std;\n\nint main() {\n    cout << "Hello Nimbus";\n    return 0;\n}');
  });

  it("starts Java with a runnable public class Main", () => {
    expect(getLanguage("java").starterCode).toMatch(/^public class Main \{\n {4}public static void main\(String\[\] args\) \{/);
  });

  it("recognises only supported language ids", () => {
    expect(isLanguageId("cpp")).toBe(true);
    expect(isLanguageId("java")).toBe(true);
    for (const value of ["python", "Java", "", "constructor", "__proto__", "toString"]) expect(isLanguageId(value)).toBe(false);
  });
});

describe("codeAfterLanguageChange", () => {
  const cpp = getLanguage("cpp").starterCode;
  const java = getLanguage("java").starterCode;

  it("swaps an untouched starter template for the new language's", () => {
    expect(codeAfterLanguageChange(cpp, "cpp", "java")).toBe(java);
    expect(codeAfterLanguageChange(java, "java", "cpp")).toBe(cpp);
  });

  it("replaces an empty editor with the new starter template", () => {
    expect(codeAfterLanguageChange("", "cpp", "java")).toBe(java);
    expect(codeAfterLanguageChange("  \n", "java", "cpp")).toBe(cpp);
  });

  it("never overwrites edited code", () => {
    const edited = `${cpp}\n// my change`;
    expect(codeAfterLanguageChange(edited, "cpp", "java")).toBe(edited);
    expect(codeAfterLanguageChange("int main() { return 1; }", "cpp", "java")).toBe("int main() { return 1; }");
  });

  it("keeps the other language's template when it is not the previous language's starter", () => {
    // E.g. Java code restored from history while C++ was selected is the user's code, not a template to replace.
    expect(codeAfterLanguageChange(java, "cpp", "java")).toBe(java);
    expect(codeAfterLanguageChange(cpp, "java", "cpp")).toBe(cpp);
  });

  it("leaves the code alone when the language does not change", () => {
    expect(codeAfterLanguageChange(cpp, "cpp", "cpp")).toBe(cpp);
  });
});
