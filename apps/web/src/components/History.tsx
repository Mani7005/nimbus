import type { Execution, ExecutionStatus } from "../services/execution";

interface HistoryProps {
  executions: Execution[];
  onSelect: (execution: Execution) => void;
  /** More, older executions can be loaded. */
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

const statusColor: Record<ExecutionStatus, string> = {
  COMPLETED: "bg-green-600",
  FAILED: "bg-red-600",
  TIMEOUT: "bg-yellow-600",
  RUNNING: "bg-blue-600",
  PENDING: "bg-gray-600",
};

function History({ executions, onSelect, hasMore, loadingMore, onLoadMore }: HistoryProps) {
  return (
    <div className="bg-zinc-900 rounded-xl p-4 h-full overflow-y-auto">
      <h2 className="text-white text-xl font-bold mb-4">Execution History</h2>
      {executions.length === 0 ? <p className="text-gray-400">No executions yet.</p> : (
        <div className="space-y-3">
          {executions.map((execution) => (
            <button key={execution.id} type="button" onClick={() => onSelect(execution)} className="bg-zinc-800 rounded-lg p-3 hover:bg-zinc-700 transition text-left w-full">
              <div className="flex justify-between items-center">
                <span className="text-blue-400 font-semibold">{execution.language.toUpperCase()}</span>
                <span className={`text-xs px-2 py-1 rounded ${statusColor[execution.status]}`}>{execution.status}</span>
              </div>
              <p className="text-gray-300 mt-2 text-sm line-clamp-2">{execution.output || "No Output"}</p>
              <p className="text-gray-500 text-xs mt-2">{new Date(execution.createdAt).toLocaleString()}</p>
            </button>
          ))}
          {hasMore && (
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore}
              className="w-full text-sm text-blue-400 hover:text-blue-300 disabled:text-zinc-500 disabled:cursor-not-allowed py-2"
            >
              {loadingMore ? "Loading..." : "Load more"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default History;
