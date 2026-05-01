"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";

const PlaygroundClient = dynamic(
  () => import("@/components/playground/PlaygroundClient").then((m) => m.PlaygroundClient),
  {
    ssr: false,
  }
);

export default function PlaygroundPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center text-text-secondary">
          Loading playground...
        </div>
      }
    >
      <PlaygroundClient />
    </Suspense>
  );
}
