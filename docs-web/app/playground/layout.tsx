import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Playground — Layercache",
  description: "Interactive playground for Layercache caching library",
};

export default function PlaygroundLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
