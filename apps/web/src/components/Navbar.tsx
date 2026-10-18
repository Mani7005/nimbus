import { LANGUAGES, isLanguageId, type LanguageId } from "../languages";
import type { User } from "../types/api";

interface NavbarProps {
  onRun: () => void;
  onLogout: () => void;
  user: User | null;
  /** True while an execution is being submitted or polled. */
  running: boolean;
  language: LanguageId;
  onLanguageChange: (language: LanguageId) => void;
}

function Navbar({ onRun, onLogout, user, running, language, onLanguageChange }: NavbarProps) {
  return (
    <header className="h-16 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between px-6">
      <h1 className="text-2xl font-bold text-white">Nimbus</h1>
      <div className="flex items-center gap-4">
        <span className="text-zinc-300">{user?.email || "User"}</span>
        <select
          aria-label="Language"
          value={language}
          disabled={running}
          onChange={(event) => {
            if (isLanguageId(event.target.value)) onLanguageChange(event.target.value);
          }}
          className="bg-zinc-800 text-white px-3 py-2 rounded-lg disabled:text-zinc-400 disabled:cursor-not-allowed"
        >
          {LANGUAGES.map(({ id, label }) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
        <button
          onClick={onRun}
          disabled={running}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-900 disabled:text-zinc-400 disabled:cursor-not-allowed px-5 py-2 rounded-lg text-white font-semibold"
        >
          {running ? "Running..." : "Run"}
        </button>
        <button onClick={onLogout} className="bg-red-600 hover:bg-red-700 px-4 py-2 rounded-lg text-white font-semibold">Logout</button>
      </div>
    </header>
  );
}

export default Navbar;
