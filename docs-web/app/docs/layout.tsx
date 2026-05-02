import { DocsHeader } from "@/components/docs/DocsHeader";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white text-black">
      <DocsHeader />
      <div className="uber-container flex">
        {children}
      </div>
    </div>
  );
}
