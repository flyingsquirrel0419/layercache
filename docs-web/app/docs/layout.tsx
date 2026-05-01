import { DocsHeader } from "@/components/docs/DocsHeader";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <DocsHeader />
      <div className="max-w-screen-xl mx-auto flex">
        {children}
      </div>
    </div>
  );
}
