"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { AnimatedSection } from "./AnimatedSection";

const layers = [
  ["Memory", "~0.01 ms"],
  ["Redis", "~0.5 ms"],
  ["Disk", "~2 ms"],
  ["Origin", "fetch"],
];

export function HowItWorks() {
  const [active, setActive] = useState(0);

  return (
    <AnimatedSection className="bg-white px-4 py-20 text-black sm:px-6">
      <div className="uber-container grid gap-10 lg:grid-cols-[0.85fr_1.15fr]">
        <div>
          <p className="mb-3 text-sm font-medium text-[#4b4b4b]">Request route</p>
          <h2 className="text-4xl font-bold leading-[1.22]">
            Fastest layer first. Source of truth only when needed.
          </h2>
          <p className="mt-4 max-w-md text-base leading-6 text-[#4b4b4b]">
            Every read travels a short, visible path. Misses continue downward,
            fetches backfill upward, and stale values keep the interface steady
            during faults.
          </p>
        </div>

        <div className="uber-card p-4">
          <div className="mb-4 flex flex-wrap gap-2">
            {layers.map(([name], index) => (
              <button
                key={name}
                onClick={() => setActive(index)}
                className={`min-h-11 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                  active === index
                    ? "bg-black text-white"
                    : "bg-[#efefef] text-black hover:bg-[#e2e2e2]"
                }`}
              >
                {name}
              </button>
            ))}
          </div>

          <div className="grid gap-3">
            {layers.map(([name, speed], index) => (
              <motion.div
                key={name}
                animate={{ x: active === index ? 8 : 0 }}
                className={`flex min-h-16 items-center justify-between rounded-lg px-5 ${
                  active === index
                    ? "bg-black text-white"
                    : "bg-white shadow-[rgba(0,0,0,0.12)_0px_4px_16px_0px]"
                }`}
              >
                <div>
                  <p className="text-xl font-bold leading-tight">{name}</p>
                  <p
                    className={`text-sm ${
                      active === index ? "text-white/75" : "text-[#4b4b4b]"
                    }`}
                  >
                    {index === active ? "active checkpoint" : "standby checkpoint"}
                  </p>
                </div>
                <span className="rounded-full bg-[#efefef] px-3 py-1 text-sm font-medium text-black">
                  {speed}
                </span>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </AnimatedSection>
  );
}
