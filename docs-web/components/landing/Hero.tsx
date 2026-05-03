"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import Button from "@/components/ui/Button";
import { CheckIcon, CopyIcon } from "@/components/ui/Icons";

const COMMANDS = [
  "npm install layercache",
  "pnpm add layercache",
  "yarn add layercache",
];

async function writeClipboardText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();

    try {
      document.execCommand("copy");
      return true;
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

export function Hero() {
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  const copyCommand = async (command: string) => {
    if (await writeClipboardText(command)) {
      setCopiedCommand(command);
      window.setTimeout(() => setCopiedCommand(null), 1600);
    }
  };

  return (
    <section className="bg-white px-4 pb-16 pt-10 text-black sm:px-6 lg:pb-24">
      <div className="uber-container grid items-center gap-10 lg:grid-cols-[1.02fr_0.98fr]">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: "easeOut" }}
          className="max-w-xl"
        >
          <div className="mb-5 flex flex-wrap gap-2">
            {["Node.js >= 20", "v2.1.0", "Apache-2.0"].map((label, index) => (
              <span
                key={label}
                className={`rounded-full px-4 py-2 text-sm font-medium ${
                  index === 0
                    ? "bg-black text-white"
                    : "bg-[#efefef] text-black"
                }`}
              >
                {label}
              </span>
            ))}
          </div>

          <h1 className="max-w-3xl text-[44px] font-bold leading-[1.12] text-black sm:text-[52px]">
            Production-ready caching with transit-system clarity.
          </h1>

          <p className="mt-5 max-w-lg text-base leading-6 text-[#4b4b4b]">
            Stack memory, Redis, disk, and Memcached behind one compact API.
            Layercache keeps hot paths predictable with single-flight fetches,
            tag invalidation, stale serving, and operational metrics.
          </p>

          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <Button variant="primary" href="/docs/getting-started">
              Get started
            </Button>
            <Button variant="ghost" href="/playground">
              Open playground
            </Button>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.08, ease: "easeOut" }}
          className="grid gap-4"
        >
          <div className="uber-card overflow-hidden">
            <div className="flex items-center justify-between border-b border-black px-5 py-4">
              <div className="flex items-center gap-3">
                <img src="/logo.png" alt="Layercache" className="h-10 w-28 object-contain object-left" />
                <div>
                  <p className="text-sm font-bold">Layercache</p>
                  <p className="text-xs text-[#4b4b4b]">multi-layer cache stack</p>
                </div>
              </div>
              <span className="rounded-full bg-black px-3 py-1 text-xs font-medium text-white">
                READY
              </span>
            </div>

            <div className="grid gap-3 p-5">
              {COMMANDS.map((command) => (
                <div
                  key={command}
                  className="flex min-h-11 items-center justify-between rounded-lg border border-black px-4 text-sm"
                >
                  <code className="font-mono">{command}</code>
                  <button
                    type="button"
                    onClick={() => copyCommand(command)}
                    className="inline-flex min-h-9 items-center gap-2 rounded-full bg-[#efefef] px-3 text-xs font-medium text-black transition-colors hover:bg-[#e2e2e2]"
                    aria-label={`Copy ${command}`}
                  >
                    {copiedCommand === command ? (
                      <CheckIcon className="h-4 w-4" />
                    ) : (
                      <CopyIcon className="h-4 w-4" />
                    )}
                    {copiedCommand === command ? "copied" : "copy"}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            {[
              ["549", "tests"],
              ["3", "core layers"],
              ["50ms", "Redis timeout"],
            ].map(([value, label]) => (
              <div key={label} className="uber-card p-4">
                <p className="text-2xl font-bold leading-none">{value}</p>
                <p className="mt-2 text-sm text-[#4b4b4b]">{label}</p>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}
