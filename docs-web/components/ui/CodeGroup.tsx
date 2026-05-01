"use client";

import { useState } from "react";

type CodeGroupProps = {
  labels: string[];
  children: React.ReactNode[];
};

export default function CodeGroup({ labels, children }: CodeGroupProps) {
  const [activeIndex, setActiveIndex] = useState(0);

  return (
    <div className="my-6 rounded-lg overflow-hidden border border-border">
      <div className="flex border-b border-border bg-surface">
        {labels.map((label, index) => (
          <button
            key={index}
            onClick={() => setActiveIndex(index)}
            className={`px-4 py-2 text-sm font-medium transition-colors duration-150 ${
              index === activeIndex
                ? "text-accent border-b-2 border-accent"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div>{children[activeIndex]}</div>
    </div>
  );
}
