"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect } from "react";
import { AnimatedSection } from "./AnimatedSection";

interface LayerBarProps {
  label: string;
  speed: string;
  colorClass: string;
  active: boolean;
  badge?: string;
  icon: React.ReactNode;
  ringColor?: string;
}

function LayerBar({ label, speed, colorClass, active, badge, icon, ringColor }: LayerBarProps) {
  const getBadgeColor = () => {
    if (badge === "MISS") return "bg-red-500/20 text-red-400";
    if (badge === "FETCH") return "bg-green-500/20 text-green-400";
    if (badge === "SET") return "bg-green-500/20 text-green-400";
    return "";
  };

  return (
    <motion.div
      animate={active ? { scale: 1.02 } : { scale: 1 }}
      transition={{ duration: 0.2 }}
      className={`rounded-lg border p-4 flex items-center justify-between ${colorClass} ${
        active && ringColor ? `${ringColor}` : ""
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="text-xl">{icon}</span>
        <span className="font-medium">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-text-secondary">{speed}</span>
        {badge && (
          <AnimatePresence>
            <motion.span
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              className={`text-xs px-2 py-0.5 rounded-full font-medium ${getBadgeColor()}`}
            >
              {badge}
            </motion.span>
          </AnimatePresence>
        )}
      </div>
    </motion.div>
  );
}

export function HowItWorks() {
  const [simulating, setSimulating] = useState(false);
  const [activeStep, setActiveStep] = useState<number | null>(null);
  const [badges, setBadges] = useState<(string | null)[]>([null, null, null, null]);
  const [ringColor, setRingColor] = useState<string | null>(null);

  const layers = [
    {
      label: "Memory (L1)",
      speed: "~ 0.01 ms",
      colorClass: "bg-accent/10 border-accent/30",
      icon: "🔲",
    },
    {
      label: "Redis (L2)",
      speed: "~ 0.5 ms",
      colorClass: "bg-purple-500/10 border-purple-500/30",
      icon: "🗄️",
    },
    {
      label: "Disk (L3)",
      speed: "~ 2 ms",
      colorClass: "bg-blue-500/10 border-blue-500/30",
      icon: "💾",
    },
    {
      label: "Data Source",
      speed: "varies",
      colorClass: "bg-amber-500/10 border-amber-500/30",
      icon: "🌐",
    },
  ];

  const simulateRequest = () => {
    if (simulating) return;
    setSimulating(true);
    setActiveStep(0);

    // Step 1: Memory MISS
    setBadges(["MISS", null, null, null]);
    setRingColor("ring-2 ring-offset-2 ring-offset-background ring-red-400");

    setTimeout(() => {
      // Step 2: Redis MISS
      setActiveStep(1);
      setBadges([null, "MISS", null, null]);
    }, 800);

    setTimeout(() => {
      // Step 3: Disk MISS
      setActiveStep(2);
      setBadges([null, null, "MISS", null]);
    }, 1600);

    setTimeout(() => {
      // Step 4: Fetch from source
      setActiveStep(3);
      setBadges([null, null, null, "FETCH"]);
      setRingColor("ring-2 ring-offset-2 ring-offset-background ring-green-400");
    }, 2400);

    setTimeout(() => {
      // Step 5: Backfill all layers
      setActiveStep(null);
      setBadges(["SET", "SET", "SET", null]);
    }, 3400);

    setTimeout(() => {
      // Reset
      setBadges([null, null, null, null]);
      setRingColor(null);
      setSimulating(false);
    }, 4200);
  };

  return (
    <AnimatedSection className="py-24 px-6">
      <div className="max-w-5xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-bold text-center mb-4">How It Works</h2>
        <p className="text-text-secondary text-center mb-12">
          Data flows through layers from fastest to slowest, with automatic backfill
        </p>

        <div className="max-w-lg mx-auto mb-8">
          <div className="flex flex-col gap-3">
            {layers.map((layer, index) => (
              <div key={index} className="relative">
                <LayerBar
                  label={layer.label}
                  speed={layer.speed}
                  colorClass={layer.colorClass}
                  active={activeStep === index}
                  badge={badges[index] || undefined}
                  icon={layer.icon}
                  ringColor={ringColor && (activeStep === index || badges[index] === "SET") ? ringColor : ""}
                />
                {index < layers.length - 1 && (
                  <div className="flex justify-center -my-1 relative z-10">
                    <motion.svg
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      className="text-accent"
                      animate={
                        activeStep === index || (activeStep === null && badges.some(b => b === "SET"))
                          ? { y: [0, 4, 0] }
                          : {}
                      }
                      transition={{ duration: 0.5, repeat: Infinity }}
                    >
                      <path
                        d="M12 4L12 20M12 20L8 16M12 20L16 16"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </motion.svg>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-center">
          <button
            onClick={simulateRequest}
            disabled={simulating}
            className={`px-6 py-3 rounded-lg font-medium transition-colors ${
              simulating
                ? "bg-gray-700 text-gray-400 cursor-not-allowed"
                : "bg-accent text-white hover:bg-accent-light"
            }`}
          >
            {simulating ? "Simulating..." : "Simulate Request"}
          </button>
        </div>
      </div>
    </AnimatedSection>
  );
}
