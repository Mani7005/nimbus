import { useEffect, useState } from "react";
import Navbar from "./components/Navbar";
import Output from "./components/Output";
import History from "./components/History";
import CodeEditor from "./components/CodeEditor";
import { me } from "./services/auth";
import Login from "./pages/Login";
import Register from "./pages/Register";

import { getToken, removeToken } from "./utils/storage";

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
  const [language, setLanguage] = useState("cpp");
  const [input, setInput] = useState("");

  const [executions, setExecutions] = useState<any[]>([]);
  const [user, setUser] = useState<any>(null);

  const [isLoggedIn, setIsLoggedIn] = useState(
    Boolean(getToken())
  );

  const [showRegister, setShowRegister] = useState(false);

  // ------------------------
  // Load History
  // ------------------------

  const loadHistory = async () => {
    try {
      const data = await getExecutions();
      setExecutions(data.executions);
    } catch (err) {
      console.error(err);
    }
  };

  // ------------------------
  // Load User
  // ------------------------

  const loadUser = async () => {
    try {
      const data = await me();
      setUser(data.user);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    if (isLoggedIn) {
      loadHistory();
      loadUser();
    }
  }, [isLoggedIn]);

  // ------------------------
  // Run Code
  // ------------------------

  const handleRun = async () => {
    try {
      setOutput("Running...");

      const result = await executeCode(
        language,
        code,
        input
      );

      const executionId = result.execution.id;

      const interval = setInterval(async () => {
        try {
          const response = await getExecution(
            executionId
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

          setOutput(
            "Failed to fetch execution."
          );
        }
      }, 1000);
    } catch (err) {
      console.error(err);

      setOutput("Execution Failed");
    }
  };

  // ------------------------
  // Logout
  // ------------------------

  const logout = () => {
    removeToken();
    setIsLoggedIn(false);
    setUser(null);
  };

  // ------------------------
  // Restore History
  // ------------------------

  const handleHistorySelect = (
    execution: any
  ) => {
    setCode(execution.code);

    setOutput(
      execution.output || "No Output"
    );

    setLanguage(execution.language);

    setInput(execution.input || "");
  };

  // ------------------------
  // Login/Register
  // ------------------------

  if (!isLoggedIn) {
    return showRegister ? (
      <Register
        onRegister={() => setIsLoggedIn(true)}
        goToLogin={() => setShowRegister(false)}
      />
    ) : (
      <Login
        onLogin={() => setIsLoggedIn(true)}
        goToRegister={() => setShowRegister(true)}
      />
    );
  }

  // ------------------------
  // IDE
  // ------------------------

  return (
    <div className="min-h-screen bg-zinc-950">
      <Navbar
        onRun={handleRun}
        onLogout={logout}
        user={user}
      />

      <div className="p-6 h-[calc(100vh-64px)]">
        <div className="grid grid-cols-3 gap-6 h-full">

          {/* Editor */}

          <div className="col-span-2">
            <CodeEditor
              code={code}
              setCode={setCode}
            />
          </div>

          {/* Right Panel */}

          <div className="flex flex-col gap-4">

            {/* Output */}

            <div className="flex-1">
              <Output output={output} />
            </div>

            {/* Input */}

            <div className="bg-zinc-900 rounded-lg p-4">
              <h2 className="text-white font-semibold mb-2">
                Input
              </h2>

              <textarea
                value={input}
                onChange={(e) =>
                  setInput(e.target.value)
                }
                placeholder="Enter stdin here..."
                className="w-full h-28 bg-zinc-950 text-white rounded p-3 outline-none resize-none"
              />
            </div>

            {/* History */}

            <div className="flex-1">
              <History
                executions={executions}
                onSelect={handleHistorySelect}
              />
            </div>

          </div>

        </div>
      </div>
    </div>
  );
}

export default App;