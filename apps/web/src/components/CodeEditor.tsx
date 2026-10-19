import Editor from "@monaco-editor/react";

interface CodeEditorProps {
  code: string;
  /** Monaco language id. */
  language: string;
  onCodeChange: (code: string) => void;
}

function CodeEditor({ code, language, onCodeChange }: CodeEditorProps) {
  return (
    <Editor
      height="100%"
      language={language}
      theme="vs-dark"
      value={code}
      onChange={(value) => onCodeChange(value || "")}
      options={{ fontSize: 16, minimap: { enabled: false }, automaticLayout: true }}
    />
  );
}

export default CodeEditor;
