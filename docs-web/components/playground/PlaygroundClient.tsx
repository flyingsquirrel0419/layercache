"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { CodeEditor } from "./CodeEditor";
import { ResultPanel } from "./ResultPanel";
import { PresetSelector } from "./PresetSelector";
import { presets } from "@/lib/playground/presets";
import {
  RUN_TIMEOUT_MS,
  armRunTimeout,
  clearRunTimeout,
} from "@/lib/playground/run-timeout-controller.mjs";

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
  const [isRunning, setIsRunning] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopWorker = useCallback((worker: Worker | null = workerRef.current) => {
    clearRunTimeout(timeoutRef);

    if (!worker) {
      return;
    }

    worker.terminate();
    if (workerRef.current === worker) {
      workerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopWorker();
  }, [stopWorker]);

  const handleRun = useCallback(() => {
    if (isRunning) return;

    // Clean up any previous worker
    stopWorker();

    // Create fresh worker
    const worker = new Worker(
      new URL("../../lib/playground/worker.ts", import.meta.url)
    );

    worker.onmessage = (event) => {
      const { type, message, timestamp, layerInfo } = event.data;
      if (type === "log" || type === "error" || type === "cache") {
        setLogs((prev) => [...prev, { type, message, timestamp }]);
      } else if (type === "done") {
        stopWorker(worker);
        setLayerInfo(layerInfo);
        setIsRunning(false);
      }
    };

    worker.onerror = (error) => {
      setLogs((prev) => [
        ...prev,
        { type: "error" as const, message: `Error: ${error.message || "Worker failed"}`, timestamp: Date.now() },
      ]);
      stopWorker(worker);
      setIsRunning(false);
    };

    workerRef.current = worker;

    // Main-thread kill timer — still fires when the worker thread is stuck in a sync loop.
    armRunTimeout({
      timeoutRef,
      ms: RUN_TIMEOUT_MS,
      onTimeout: () => {
        if (workerRef.current !== worker) {
          return;
        }

        setLogs((prev) => [
          ...prev,
          { type: "error" as const, message: "Execution timed out (30s limit) — worker terminated", timestamp: Date.now() },
        ]);
        stopWorker(worker);
        setIsRunning(false);
      },
    });

    setLogs([]);
    setLayerInfo(undefined);
    setIsRunning(true);
    worker.postMessage({ type: "run", code });
  }, [code, isRunning, stopWorker]);

  const handlePresetSelect = useCallback((id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (preset) {
      setCode(preset.code);
      setActivePreset(id);
      setLogs([]);
      setLayerInfo(undefined);
    }
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="min-h-screen bg-background"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h1 className="text-lg font-bold text-text-primary">Playground</h1>
        <button
          onClick={handleRun}
          disabled={isRunning}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            isRunning
              ? "bg-surface text-text-secondary cursor-not-allowed"
              : "bg-accent text-white hover:opacity-90"
          }`}
        >
          {isRunning ? "Running..." : "Run"}
        </button>
      </div>

      {/* Preset Selector */}
      <PresetSelector activeId={activePreset} onSelect={handlePresetSelect} />

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 h-[calc(100vh-8rem)]">
        {/* Code Editor */}
        <div className="border-r border-border p-0">
          <CodeEditor value={code} onChange={setCode} />
        </div>

        {/* Result Panel */}
        <div className="p-0">
          <ResultPanel logs={logs} layerInfo={layerInfo} />
        </div>
      </div>
    </motion.div>
  );
}
