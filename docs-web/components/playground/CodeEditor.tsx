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
        className={`h-full min-h-[520px] w-full resize-none border-0 bg-[#fbfbfb] p-5 font-mono text-sm leading-6 text-black outline-none focus:shadow-[inset_0_0_0_2px_rgb(0,0,0)] ${className}`}
        spellCheck={false}
        {...props}
      />
    );
  }
);

CodeEditor.displayName = "CodeEditor";
