import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,jsx,ts,tsx,md,mdx}",
    "./components/**/*.{js,jsx,ts,tsx,md,mdx}",
    "./content/**/*.{js,jsx,ts,tsx,md,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--color-background)",
        surface: "var(--color-surface)",
        border: "var(--color-border)",
        "text-primary": "var(--color-text-primary)",
        "text-secondary": "var(--color-text-secondary)",
        accent: "var(--color-accent)",
        "accent-light": "var(--color-accent-light)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-jetbrains)", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
