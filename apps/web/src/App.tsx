import { useCallback, useEffect, useRef, useState } from "react";
import IdeWorkspace from "./components/IdeWorkspace";
import Navbar from "./components/Navbar";
import { useExecutionRunner } from "./hooks/useExecutionRunner";
import Login from "./pages/Login";
import Register from "./pages/Register";
import { me } from "./services/auth";
import { getExecutions, type Execution } from "./services/execution";
import { appendHistoryPage, type HistoryPage } from "./services/history";
import type { User } from "./types/api";
import { getToken, removeToken } from "./utils/storage";

const INITIAL_CODE = `#include<iostream>
using namespace std;

int main() {
    cout << "Hello Nimbus";
    return 0;
}`;

function App() {
  const [code, setCode] = useState(INITIAL_CODE);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("Ready...");
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(Boolean(getToken()));
  const [showRegister, setShowRegister] = useState(false);
  // Bumped whenever the list is replaced or cleared, so a "Load more" response that arrives afterwards is dropped.
  const historyVersion = useRef(0);

  const fetchHistory = useCallback(async (): Promise<HistoryPage> => {
    try {
      const { executions: history, nextCursor: cursor } = await getExecutions();
      return { executions: history, nextCursor: cursor };
    } catch (error) {
      console.error(error);
      return { executions: [], nextCursor: null };
    }
  }, []);

  const showHistory = useCallback((page: HistoryPage) => {
    historyVersion.current++;
    setExecutions(page.executions);
    setNextCursor(page.nextCursor);
  }, []);

  const refreshHistory = useCallback(async () => {
    showHistory(await fetchHistory());
  }, [fetchHistory, showHistory]);

  const loadMoreHistory = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const version = historyVersion.current;
    try {
      const page = await getExecutions({ cursor: nextCursor });
      if (version !== historyVersion.current) return;
      setExecutions((current) => appendHistoryPage(current, page.executions));
      setNextCursor(page.nextCursor);
    } catch (error) {
      // E.g. the cursor's execution was deleted meanwhile; start again from the newest page.
      console.error(error);
      if (version === historyVersion.current) await refreshHistory();
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, refreshHistory]);

  const fetchUser = useCallback(async (): Promise<User | null> => {
    try {
      const { user: currentUser } = await me();
      return currentUser;
    } catch (error) {
      console.error(error);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!isLoggedIn) {
      return;
    }

    void (async () => {
      const [history, currentUser] = await Promise.all([fetchHistory(), fetchUser()]);
      showHistory(history);
      setUser(currentUser);
    })();
  }, [fetchHistory, fetchUser, isLoggedIn, showHistory]);

  const { run: runExecution, cancel: cancelExecution, isRunning } = useExecutionRunner({
    onComplete: refreshHistory,
    onOutputChange: setOutput,
  });

  const handleHistorySelect = useCallback((execution: Execution) => {
    setCode(execution.code);
    setInput(execution.input || "");
    setOutput(execution.output || "No Output");
  }, []);

  const handleLogout = useCallback(() => {
    cancelExecution();
    historyVersion.current++;
    removeToken();
    setIsLoggedIn(false);
    setUser(null);
    setExecutions([]);
    setNextCursor(null);
    setOutput("Ready...");
  }, [cancelExecution]);

  if (!isLoggedIn) {
    return showRegister ? (
      <Register onRegister={() => setIsLoggedIn(true)} goToLogin={() => setShowRegister(false)} />
    ) : (
      <Login onLogin={() => setIsLoggedIn(true)} goToRegister={() => setShowRegister(true)} />
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950">
      <Navbar onRun={() => void runExecution("cpp", code, input)} onLogout={handleLogout} user={user} running={isRunning} />
      <IdeWorkspace
        code={code}
        input={input}
        output={output}
        executions={executions}
        hasMoreHistory={nextCursor !== null}
        loadingMoreHistory={loadingMore}
        onCodeChange={setCode}
        onInputChange={setInput}
        onHistorySelect={handleHistorySelect}
        onLoadMoreHistory={() => void loadMoreHistory()}
      />
    </div>
  );
}

export default App;
