"use client";

import { presets } from "@/lib/playground/presets";

interface PresetSelectorProps {
  activeId: string | null;
  onSelect: (id: string) => void;
}

export function PresetSelector({ activeId, onSelect }: PresetSelectorProps) {
  return (
    <div className="flex gap-2 overflow-x-auto">
      {presets.map((preset) => (
        <button
          key={preset.id}
          onClick={() => onSelect(preset.id)}
          title={preset.description}
          className={`min-h-11 whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition-colors ${
            activeId === preset.id
              ? "bg-black text-white"
              : "bg-[#efefef] text-black hover:bg-[#e2e2e2]"
          }`}
        >
          {preset.title}
        </button>
      ))}
    </div>
  );
}
