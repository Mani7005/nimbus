import Editor from "@monaco-editor/react";

interface CodeEditorProps {
  code: string;
  setCode: React.Dispatch<React.SetStateAction<string>>;
}

function CodeEditor({
  code,
  setCode,
}: CodeEditorProps) {
  return (
    <Editor
      height="100%"
      language="cpp"
      theme="vs-dark"
      value={code}
      onChange={(value) => setCode(value || "")}
      options={{
        fontSize: 16,
        minimap: {
          enabled: false,
        },
        automaticLayout: true,
      }}
    />
  );
}

export default CodeEditor;