import CopyButton from "@/components/ui/CopyButton";
import Callout from "@/components/ui/Callout";
import CodeGroup from "@/components/ui/CodeGroup";
import Stepper from "@/components/ui/Stepper";

export function getMDXComponents() {
  return {
    Callout,
    CodeGroup,
    Stepper,
    // Override pre tag for code blocks
    pre: ({ children }: { children: React.ReactNode }) => {
      // Extract text from code child for copy button
      const codeElement = children as React.ReactElement & { props?: { children?: string; className?: string } };
      const codeText = typeof codeElement?.props?.children === "string"
        ? codeElement.props.children
        : "";
      const filename = codeElement?.props?.className?.replace("language-", "") || "";

      return (
        <div className="relative group my-6">
          {filename && (
            <div className="flex items-center justify-between px-4 py-2 bg-surface border border-border border-b-0 rounded-t-lg">
              <span className="text-xs text-text-secondary">{filename}</span>
            </div>
          )}
          <pre className={`${filename ? "border-t-0 rounded-t-none" : ""} overflow-x-auto rounded-lg border border-border bg-surface p-4 text-sm`}>
            {children}
          </pre>
          {codeText && <CopyButton text={codeText} />}
        </div>
      );
    },
    // Style inline code
    code: ({ children, className }: { children: React.ReactNode; className?: string }) => {
      // If inside a pre block (code block), just render as-is
      if (className) {
        return <code className={className}>{children}</code>;
      }
      // Inline code
      return (
        <code className="px-1.5 py-0.5 rounded bg-surface border border-border text-sm font-mono">
          {children}
        </code>
      );
    },
    // Style tables
    table: ({ children }: { children: React.ReactNode }) => (
      <div className="my-6 overflow-x-auto">
        <table className="w-full border-collapse border border-border">
          {children}
        </table>
      </div>
    ),
    th: ({ children }: { children: React.ReactNode }) => (
      <th className="border border-border px-4 py-2 bg-surface text-left text-sm font-semibold">
        {children}
      </th>
    ),
    td: ({ children }: { children: React.ReactNode }) => (
      <td className="border border-border px-4 py-2 text-sm">{children}</td>
    ),
  };
}
