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
        return "text-black";
      case "cache":
        return "text-text-primary";
      default:
        return "text-text-primary";
    }
  };

  const formatTimestamp = (timestamp: number): string => {
    const elapsed = timestamp - startTime;
    return `[${elapsed}ms]`;
  };

  return (
    <div className="flex h-full min-h-[520px] flex-col bg-white">
      {/* Console output */}
      <div className="flex-1 overflow-y-auto bg-[#fbfbfb] p-5">
        {logs.length === 0 ? (
          <div className="flex h-full min-h-[320px] items-center justify-center rounded-lg border border-dashed border-[#afafaf] bg-white text-sm text-[#4b4b4b]">
            Run code to see output here
          </div>
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
        <div className="border-t border-black bg-white p-4">
          <div className="flex flex-wrap gap-2">
            {layerInfo.map((layer) => (
              <div
                key={layer.name}
                className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-2 shadow-[rgba(0,0,0,0.12)_0px_4px_16px_0px]"
              >
                <div
                  className={`w-2 h-2 rounded-full ${
                    layer.size > 0 ? "bg-black" : "bg-[#afafaf]"
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
