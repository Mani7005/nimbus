import { useEffect, useState } from "react";
import Navbar from "./components/Navbar";
import Output from "./components/Output";
import History from "./components/History";
import CodeEditor from "./components/CodeEditor";
import { TOKEN } from "./config";
import {
  executeCode,
  getExecution,
  getExecutions,
} from "./services/execution";

function App() {
  const [code, setCode] = useState(`#include<iostream>
using namespace std;

int main() {
    cout << "Hello Nimbus";
    return 0;
}`);

  const [output, setOutput] = useState("Ready...");
  const [language] = useState("cpp");
  const [executions, setExecutions] = useState<any[]>([]);

  // Load execution history
  const loadHistory = async () => {
    try {
      const data = await getExecutions(TOKEN);
      setExecutions(data.executions);
    } catch (err) {
      console.error(err);
    }
  };

  // Load history when page opens
  useEffect(() => {
    loadHistory();
  }, []);

  // Run code
  const handleRun = async () => {
    try {
      setOutput("Running...");

      const result = await executeCode(
        language,
        code,
        TOKEN
      );

      const executionId = result.execution.id;

      const interval = setInterval(async () => {
        try {
          const response = await getExecution(
            executionId,
            TOKEN
          );

          const execution = response.execution;

          if (
            execution.status === "COMPLETED" ||
            execution.status === "FAILED" ||
            execution.status === "TIMEOUT"
          ) {
            clearInterval(interval);

            setOutput(
              execution.output || "No Output"
            );

            await loadHistory();
          }
        } catch (err) {
          clearInterval(interval);
          console.error(err);
          setOutput("Failed to fetch execution result.");
        }
      }, 1000);
    } catch (err) {
      console.error(err);
      setOutput("Execution Failed");
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950">
      <Navbar onRun={handleRun} />

      <div className="p-6 h-[calc(100vh-64px)]">
        <div className="grid grid-cols-3 gap-6 h-full">

          {/* Editor */}
          <div className="col-span-2">
            <CodeEditor
              code={code}
              setCode={setCode}
            />
          </div>

          {/* Right Side */}
          <div className="flex flex-col gap-6">

            <div className="flex-1">
              <Output output={output} />
            </div>

            <div className="flex-1">
              <History executions={executions} />
            </div>

          </div>

        </div>
      </div>
    </div>
  );
}

export default App;