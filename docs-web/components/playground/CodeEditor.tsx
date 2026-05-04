"use client";

import styles from "./PlaygroundClient.module.css";

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function CodeEditor({ value, onChange, className }: CodeEditorProps) {
  const editorClassName = className
    ? `${styles.codeEditor} ${className}`
    : styles.codeEditor;

  return (
    <textarea
      value={value}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
      className={editorClassName}
    />
  );
}
