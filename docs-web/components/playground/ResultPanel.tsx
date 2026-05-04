"use client";

import styles from "./PlaygroundClient.module.css";

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
  isRunning: boolean;
  activeTab: "logs" | "layers";
  onTabChange: (tab: "logs" | "layers") => void;
}

export function ResultPanel({
  logs,
  layerInfo,
  isRunning,
  activeTab,
  onTabChange,
}: ResultPanelProps) {
  const startTime = logs.length > 0 ? logs[0].timestamp : Date.now();

  const getLogClassName = (type: LogEntry["type"]): string => {
    switch (type) {
      case "log":
        return styles.logLineLog;
      case "error":
        return styles.logLineError;
      case "cache":
        return styles.logLineCache;
      default:
        return styles.logLineLog;
    }
  };

  const formatTimestamp = (timestamp: number): string => {
    const elapsed = timestamp - startTime;
    return `[${elapsed}ms]`;
  };

  return (
    <div className={styles.resultRoot}>
      <div className={styles.resultTabs}>
        <button
          onClick={() => onTabChange("logs")}
          className={`${styles.resultTabButton} ${
            activeTab === "logs"
              ? styles.resultTabButtonActive
              : styles.resultTabButtonInactive
          }`}
        >
          Logs
        </button>
        <button
          onClick={() => onTabChange("layers")}
          className={`${styles.resultTabButton} ${
            activeTab === "layers"
              ? styles.resultTabButtonActive
              : styles.resultTabButtonInactive
          }`}
        >
          Layers
        </button>
      </div>

      <div className={styles.resultBody}>
        {activeTab === "logs" ? (
          logs.length === 0 ? (
            <div className={styles.resultPlaceholder}>
              {isRunning ? "Running..." : "Run code to see output here"}
            </div>
          ) : (
            <div className={styles.logList}>
              {logs.map((log, index) => (
                <div
                  key={index}
                  className={`${styles.logLine} ${getLogClassName(log.type)}`}
                >
                  <span className={styles.logTimestamp}>
                    {formatTimestamp(log.timestamp)}
                  </span>{" "}
                  {log.message}
                </div>
              ))}
            </div>
          )
        ) : !layerInfo || layerInfo.length === 0 ? (
          <div className={styles.resultPlaceholder}>
            Run code to inspect layer states
          </div>
        ) : (
          <div className={styles.layerGrid}>
            {layerInfo.map((layer) => (
              <div
                key={layer.name}
                className={styles.layerCard}
              >
                <div className={styles.layerCardHeader}>
                  <strong className={styles.layerName}>{layer.name}</strong>
                  <span className={styles.layerMeta}>
                    {layer.size} {layer.size === 1 ? "item" : "items"}
                  </span>
                </div>
                <div className={styles.layerMetaLine}>
                  latency: {layer.latencyMs}ms
                </div>
                {layer.keys.length > 0 && (
                  <div className={styles.layerMetaLineKeys}>
                    keys: {layer.keys.join(", ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
