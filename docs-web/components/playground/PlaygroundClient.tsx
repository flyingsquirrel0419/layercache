"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { CodeEditor } from "./CodeEditor";
import { ResultPanel } from "./ResultPanel";
import { PresetSelector } from "./PresetSelector";
import { BookIcon, GithubIcon, HomeIcon, PlayIcon } from "@/components/ui/Icons";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
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
      className="min-h-screen bg-white text-black"
    >
      <header className="sticky top-0 z-40 bg-white shadow-[rgba(0,0,0,0.12)_0px_4px_16px_0px]">
        <div className="uber-container flex h-16 items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-3" aria-label="Layercache home">
            <img src="/logo.png" alt="" className="h-7 w-24 object-contain object-left" />
            <span className="text-lg font-bold leading-none">Playground</span>
          </Link>

          <div className="hidden items-center gap-2 md:flex">
            <Link
              href="/"
              className="flex items-center gap-2 rounded-full bg-[#efefef] px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-[#e2e2e2]"
            >
              <HomeIcon className="h-4 w-4" />
              Home
            </Link>
            <Link
              href="/docs"
              className="flex items-center gap-2 rounded-full bg-[#efefef] px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-[#e2e2e2]"
            >
              <BookIcon className="h-4 w-4" />
              Docs
            </Link>
            <a
              href="https://github.com/flyingsquirrel0419/layercache"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-full bg-[#efefef] px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-[#e2e2e2]"
            >
              <GithubIcon className="h-4 w-4" />
              GitHub
            </a>
          </div>

          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button
              onClick={handleRun}
              disabled={isRunning}
              className={`flex min-h-11 items-center gap-2 rounded-full px-5 py-2 font-medium transition-colors ${
                isRunning
                  ? "cursor-not-allowed bg-[#efefef] text-[#4b4b4b]"
                  : "bg-black text-white hover:bg-[#2a2a2a]"
              }`}
            >
              <PlayIcon className="h-4 w-4" />
              {isRunning ? "Running..." : "Run"}
            </button>
          </div>
        </div>
      </header>

      <main className="uber-container px-4 py-6 sm:px-6">
        <div className="mb-5">
          <div>
            <div className="mb-3 flex gap-2 md:hidden">
              <Link href="/" className="flex items-center gap-2 rounded-full bg-[#efefef] px-4 py-2 text-sm font-medium text-black">
                <HomeIcon className="h-4 w-4" />
                Home
              </Link>
              <Link href="/docs" className="flex items-center gap-2 rounded-full bg-[#efefef] px-4 py-2 text-sm font-medium text-black">
                <BookIcon className="h-4 w-4" />
                Docs
              </Link>
            </div>
            <p className="text-sm font-medium text-[#4b4b4b]">Interactive cache lab</p>
            <h1 className="mt-1 text-4xl font-bold leading-[1.22]">Run Layercache examples in-browser.</h1>
          </div>
          <div className="mt-5 max-w-full">
            <PresetSelector activeId={activePreset} onSelect={handlePresetSelect} />
          </div>
        </div>

        <section className="grid overflow-hidden rounded-xl border border-black bg-white shadow-[rgba(0,0,0,0.12)_0px_4px_16px_0px] lg:grid-cols-2">
          <div className="border-b border-black lg:border-b-0 lg:border-r">
            <div className="flex min-h-14 items-center justify-between border-b border-black px-5">
              <div>
                <p className="text-sm font-bold">Code</p>
                <p className="text-xs text-[#4b4b4b]">Edit a preset, then run it in the worker sandbox.</p>
              </div>
              <span className="rounded-full bg-[#efefef] px-3 py-1 text-xs font-medium text-black">editor</span>
            </div>
            <CodeEditor value={code} onChange={setCode} />
          </div>

          <div>
            <div className="flex min-h-14 items-center justify-between border-b border-black px-5">
              <div>
                <p className="text-sm font-bold">Output</p>
                <p className="text-xs text-[#4b4b4b]">Console logs and layer state after execution.</p>
              </div>
              <span className="rounded-full bg-[#efefef] px-3 py-1 text-xs font-medium text-black">result</span>
            </div>
            <ResultPanel logs={logs} layerInfo={layerInfo} />
          </div>
        </section>
      </main>
    </motion.div>
  );
}
