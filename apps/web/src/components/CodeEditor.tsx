import Editor from "@monaco-editor/react";

interface CodeEditorProps {
  code: string;
  onCodeChange: (code: string) => void;
}

function CodeEditor({ code, onCodeChange }: CodeEditorProps) {
  return (
    <Editor
      height="100%"
      language="cpp"
      theme="vs-dark"
      value={code}
      onChange={(value) => onCodeChange(value || "")}
      options={{ fontSize: 16, minimap: { enabled: false }, automaticLayout: true }}
    />
  );
}

export default CodeEditor;
