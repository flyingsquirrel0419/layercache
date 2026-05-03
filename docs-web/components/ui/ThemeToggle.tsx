"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { MonitorIcon, MoonIcon, SunIcon } from "./Icons";

const modes = [
  { value: "light", label: "Light", short: "L", Icon: SunIcon },
  { value: "dark", label: "Dark", short: "D", Icon: MoonIcon },
  { value: "system", label: "System", short: "S", Icon: MonitorIcon },
] as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const activeTheme = mounted ? theme ?? "system" : "system";

  return (
    <div
      className="inline-flex min-h-11 items-center rounded-full bg-[var(--color-chip)] p-1 text-sm font-medium"
      aria-label="Theme mode"
    >
      {modes.map((mode) => {
        const active = activeTheme === mode.value;
        const Icon = mode.Icon;

        return (
          <button
            key={mode.value}
            type="button"
            onClick={() => setTheme(mode.value)}
            className={`flex min-h-9 items-center gap-2 rounded-full px-3 transition-colors ${
              active
                ? "bg-[var(--color-text-primary)] text-[var(--color-background)]"
                : "text-[var(--color-text-primary)] hover:bg-[var(--color-hover)]"
            }`}
            aria-pressed={active}
            title={mode.label}
          >
            <Icon className="h-4 w-4" />
            <span className="hidden sm:inline">{mode.label}</span>
            <span className="sm:hidden">{mode.short}</span>
          </button>
        );
      })}
    </div>
  );
}
