interface OutputProps {
  output: string;
}

function Output({ output }: OutputProps) {
  return (
    <div className="bg-zinc-900 rounded-xl p-4 h-full">
      <h2 className="text-white font-semibold mb-4">
        Output
      </h2>

      <pre className="text-green-400 whitespace-pre-wrap">
        {output}
      </pre>
    </div>
  );
}

export default Output;