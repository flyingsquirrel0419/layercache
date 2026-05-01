"use client";

import { presets } from "@/lib/playground/presets";

interface PresetSelectorProps {
  activeId: string | null;
  onSelect: (id: string) => void;
}

export function PresetSelector({ activeId, onSelect }: PresetSelectorProps) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-2 px-4">
      {presets.map((preset) => (
        <button
          key={preset.id}
          onClick={() => onSelect(preset.id)}
          title={preset.description}
          className={`px-3 py-1.5 rounded-md text-sm whitespace-nowrap transition-colors ${
            activeId === preset.id
              ? "bg-accent text-white"
              : "bg-surface border border-border text-text-secondary hover:text-text-primary"
          }`}
        >
          {preset.title}
        </button>
      ))}
    </div>
  );
}
