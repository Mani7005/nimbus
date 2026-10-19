import { useCallback, useEffect, useRef, useState } from "react";
import IdeWorkspace from "./components/IdeWorkspace";
import Navbar from "./components/Navbar";
import { useExecutionRunner } from "./hooks/useExecutionRunner";
import { DEFAULT_LANGUAGE, codeAfterLanguageChange, getLanguage, type LanguageId } from "./languages";
import Login from "./pages/Login";
import Register from "./pages/Register";
import { me } from "./services/auth";
import { getExecutions, type Execution } from "./services/execution";
import { appendHistoryPage, restoreExecution, type HistoryPage } from "./services/history";
import type { User } from "./types/api";
import { getToken, removeToken } from "./utils/storage";

function App() {
  const [language, setLanguage] = useState<LanguageId>(DEFAULT_LANGUAGE);
  const [code, setCode] = useState(() => getLanguage(DEFAULT_LANGUAGE).starterCode);
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

  const handleLanguageChange = useCallback(
    (next: LanguageId) => {
      setCode((current) => codeAfterLanguageChange(current, language, next));
      setLanguage(next);
    },
    [language],
  );

  const handleHistorySelect = useCallback(
    (execution: Execution) => {
      const restored = restoreExecution(execution, language);
      setLanguage(restored.language);
      setCode(restored.code);
      setInput(restored.input);
      setOutput(restored.output);
    },
    [language],
  );

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
      <Navbar
        onRun={() => void runExecution(language, code, input)}
        onLogout={handleLogout}
        user={user}
        running={isRunning}
        language={language}
        onLanguageChange={handleLanguageChange}
      />
      <IdeWorkspace
        language={language}
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
