"use client";

interface LogEntry {
  type: "log" | "error" | "cache";
  message: string;
  timestamp: number;
}

interface LayerInfo {
  name: string;
  latencyMs: number;
  size: number;
  keys: string[];
}

interface ResultPanelProps {
  logs: LogEntry[];
  layerInfo?: LayerInfo[];
}

export function ResultPanel({ logs, layerInfo }: ResultPanelProps) {
  const startTime = logs.length > 0 ? logs[0].timestamp : Date.now();

  const getLogColor = (type: LogEntry["type"]): string => {
    switch (type) {
      case "log":
        return "text-text-primary";
      case "error":
        return "text-red-400";
      case "cache":
        return "text-accent";
      default:
        return "text-text-primary";
    }
  };

  const formatTimestamp = (timestamp: number): string => {
    const elapsed = timestamp - startTime;
    return `[${elapsed}ms]`;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Console output */}
      <div className="flex-1 overflow-y-auto max-h-[350px] p-4 bg-background border-b border-border">
        {logs.length === 0 ? (
          <div className="text-text-secondary text-sm">Run code to see output here</div>
        ) : (
          <div className="space-y-1">
            {logs.map((log, index) => (
              <div key={index} className={`font-mono text-sm py-0.5 ${getLogColor(log.type)}`}>
                <span className="opacity-50">{formatTimestamp(log.timestamp)}</span> {log.message}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Layer status */}
      {layerInfo && (
        <div className="p-4 bg-surface">
          <div className="flex flex-wrap gap-2">
            {layerInfo.map((layer) => (
              <div
                key={layer.name}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-background border border-border"
              >
                <div
                  className={`w-2 h-2 rounded-full ${
                    layer.size > 0 ? "bg-green-500" : "bg-gray-400"
                  }`}
                />
                <span className="text-sm font-medium text-text-primary">{layer.name}</span>
                <span className="text-xs text-text-secondary">
                  {layer.size} {layer.size === 1 ? "item" : "items"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
