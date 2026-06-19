"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Badge, Tab, Tabs } from "@rspress/core/theme";
import { CodeEditor } from "./CodeEditor";
import { ResultPanel } from "./ResultPanel";
import { PlayIcon } from "@/components/ui/Icons";
import { presets } from "@/lib/playground/presets";
import {
  RUN_TIMEOUT_MS,
  armRunTimeout,
  clearRunTimeout,
} from "@/lib/playground/run-timeout-controller.mjs";
import { runPlaygroundInSandbox } from "@/lib/playground/sandboxed-runner";
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

export function PlaygroundClient() {
  const [code, setCode] = useState(presets[0].code);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [layerInfo, setLayerInfo] = useState<LayerInfo[] | undefined>();
  const [activePreset, setActivePreset] = useState<string | null>(presets[0].id);
  const [activeTab, setActiveTab] = useState<"logs" | "layers">("logs");
  const [isRunning, setIsRunning] = useState(false);

  const runnerRef = useRef<{ stop: () => void } | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopRunner = useCallback((runner: { stop: () => void } | null = runnerRef.current) => {
    clearRunTimeout(timeoutRef);

    if (!runner) {
      return;
    }

    runner.stop();
    if (runnerRef.current === runner) {
      runnerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopRunner();
  }, [stopRunner]);

  const handleRun = useCallback(() => {
    if (isRunning) return;

    stopRunner();

    // Main-thread kill timer — still fires when the worker thread is stuck in a sync loop.
    const runner = runPlaygroundInSandbox({
      code,
      onMessage: (event) => {
        if (event.type === "log" || event.type === "error" || event.type === "cache") {
          setLogs((prev) => [...prev, { type: event.type, message: event.message, timestamp: event.timestamp }]);
        } else if (event.type === "done") {
          stopRunner(runner);
          setLayerInfo(event.layerInfo as LayerInfo[] | undefined);
          setIsRunning(false);
        }
      },
      onError: (message) => {
        setLogs((prev) => [
          ...prev,
          { type: "error" as const, message: `Error: ${message}`, timestamp: Date.now() },
        ]);
        stopRunner(runner);
        setIsRunning(false);
      },
    });
    runnerRef.current = runner;

    armRunTimeout({
      timeoutRef,
      ms: RUN_TIMEOUT_MS,
      onTimeout: () => {
        if (runnerRef.current !== runner) {
          return;
        }

        setLogs((prev) => [
          ...prev,
          { type: "error" as const, message: "Execution timed out (30s limit) — worker terminated", timestamp: Date.now() },
        ]);
        stopRunner(runner);
        setIsRunning(false);
      },
    });

    setLogs([]);
    setLayerInfo(undefined);
    setActiveTab("logs");
    setIsRunning(true);
  }, [code, isRunning, stopRunner]);

  const handlePresetSelect = useCallback((id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (preset) {
      setCode(preset.code);
      setActivePreset(id);
      setLogs([]);
      setLayerInfo(undefined);
      setActiveTab("logs");
    }
  }, []);

  const hasError = logs.some((entry) => entry.type === "error");
  const hasResult = !isRunning && logs.length > 0 && !hasError;
  const activePresetIndex = Math.max(
    0,
    presets.findIndex((preset) => preset.id === activePreset)
  );

  const statusLabel = isRunning
    ? "Running"
    : hasError
    ? "Failed"
    : hasResult
    ? "Done"
    : "Idle";

  const statusType = isRunning
    ? "info"
    : hasError
    ? "danger"
    : hasResult
    ? "tip"
    : "warning";

  const renderWorkspace = () => (
    <section className={styles.workspace}>
      <div className={styles.workspaceLayout}>
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.panelTitle}>Editor</p>
              <p className={styles.panelSub}>Edit a preset, then run it in the sandboxed worker playground.</p>
            </div>
            <div className={styles.toolbarActions}>
              <button
                onClick={handleRun}
                disabled={isRunning}
                className={`${styles.runButton} ${
                  isRunning ? styles.runButtonLoading : ""
                }`}
              >
                <PlayIcon width={16} height={16} />
                Run
              </button>
              <Badge type={statusType} outline>
                {statusLabel}
              </Badge>
            </div>
          </div>
          <div className={styles.panelBody}>
            <div className={styles.editorSurface}>
              <div className={styles.editorArea}>
                <CodeEditor value={code} onChange={setCode} className={styles.codeEditorFill} />
              </div>
            </div>
          </div>
        </div>

        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.panelTitle}>Output</p>
              <p className={styles.panelSub}>Execution logs and layer state.</p>
            </div>
          </div>
          <div className={styles.panelBody}>
            <ResultPanel
              logs={logs}
              layerInfo={layerInfo}
              isRunning={isRunning}
              activeTab={activeTab}
              onTabChange={setActiveTab}
            />
          </div>
        </div>
      </div>
    </section>
  );

  return (
    <div className={styles.root}>
      <main>
        <Tabs
          defaultIndex={activePresetIndex}
          onChange={(index) => {
            const preset = presets[index];
            if (preset) {
              handlePresetSelect(preset.id);
            }
          }}
          keepDOM={false}
          className={styles.presetTabs}
          labelItemClassName={styles.presetTabLabel}
          contentItemClassName={styles.presetTabContent}
        >
          {presets.map((preset) => (
            <Tab key={preset.id} label={preset.title}>
              {renderWorkspace()}
            </Tab>
          ))}
        </Tabs>
      </main>
    </div>
  );
}
