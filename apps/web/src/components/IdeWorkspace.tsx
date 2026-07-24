import type { Execution } from "../services/execution";
import CodeEditor from "./CodeEditor";
import ExecutionInput from "./ExecutionInput";
import History from "./History";
import Output from "./Output";

interface IdeWorkspaceProps {
  code: string;
  input: string;
  output: string;
  executions: Execution[];
  onCodeChange: (code: string) => void;
  onInputChange: (input: string) => void;
  onHistorySelect: (execution: Execution) => void;
}

function IdeWorkspace({ code, input, output, executions, onCodeChange, onInputChange, onHistorySelect }: IdeWorkspaceProps) {
  return (
    <div className="p-6 h-[calc(100vh-64px)]">
      <div className="grid grid-cols-3 gap-6 h-full">
        <div className="col-span-2"><CodeEditor code={code} onCodeChange={onCodeChange} /></div>
        <div className="flex flex-col gap-4">
          <div className="flex-1"><Output output={output} /></div>
          <ExecutionInput input={input} onChange={onInputChange} />
          <div className="flex-1"><History executions={executions} onSelect={onHistorySelect} /></div>
        </div>
      </div>
    </div>
  );
}

export default IdeWorkspace;
