interface ExecutionInputProps {
  input: string;
  onChange: (input: string) => void;
}

function ExecutionInput({ input, onChange }: ExecutionInputProps) {
  return (
    <div className="bg-zinc-900 rounded-lg p-4">
      <h2 className="text-white font-semibold mb-2">Input</h2>
      <textarea value={input} onChange={(event) => onChange(event.target.value)} placeholder="Enter stdin here..." className="w-full h-28 bg-zinc-950 text-white rounded p-3 outline-none resize-none" />
    </div>
  );
}

export default ExecutionInput;
