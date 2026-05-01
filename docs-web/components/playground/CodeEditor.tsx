"use client";

import { ComponentProps, forwardRef } from "react";

interface CodeEditorProps extends Omit<ComponentProps<"textarea">, "onChange"> {
  value: string;
  onChange: (value: string) => void;
}

export const CodeEditor = forwardRef<HTMLTextAreaElement, CodeEditorProps>(
  ({ value, onChange, className = "", ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full h-full min-h-[400px] p-4 bg-background border border-border rounded-lg font-mono text-sm resize-none outline-none focus:border-accent/50 ${className}`}
        spellCheck={false}
        {...props}
      />
    );
  }
);

CodeEditor.displayName = "CodeEditor";
