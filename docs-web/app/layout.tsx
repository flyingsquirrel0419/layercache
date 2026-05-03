import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { SITE_URL } from "@/lib/site-url";
import { ThemeProvider } from "@/components/ui/ThemeProvider";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: "Layercache — Production-Ready Multi-Layer Caching for Node.js",
  description: "Stack memory, Redis, and disk behind one API with stampede prevention, tag invalidation, stale-while-revalidate, and full observability.",
  openGraph: {
    title: "Layercache — Multi-Layer Caching for Node.js",
    description: "Production-ready multi-layer caching with stampede prevention, tag invalidation, and full observability.",
    url: SITE_URL,
    siteName: "Layercache",
    type: "website",
    images: [{ url: "/logo.png", width: 1200, height: 630, alt: "Layercache" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Layercache — Multi-Layer Caching for Node.js",
    description: "Production-ready multi-layer caching with stampede prevention, tag invalidation, and full observability.",
    images: ["/logo.png"],
  },
  metadataBase: new URL(SITE_URL),
  alternates: {
    canonical: "/",
    types: {
      "text/markdown": "/",
    },
  },
  other: {
    "ai-content-declaration": "Content-Signal: search=yes, ai-input=yes, ai-train=no",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="api-catalog" href="/.well-known/api-catalog" type="application/linkset+json" />
        <link rel="service-desc" href="/.well-known/mcp/server-card.json" type="application/json" title="MCP Server Card" />
        <link rel="service-desc" href="/.well-known/agent-card.json" type="application/json" title="A2A Agent Card" />
        <link rel="agent-skills" href="/.well-known/agent-skills/index.json" type="application/json" />
        <link rel="service-doc" href="/docs/api" type="text/html" title="Layercache API Reference" />
        <link rel="help" href="/docs" type="text/html" title="Layercache Documentation" />
        <link rel="alternate" href="/" type="text/markdown" title="Markdown version" />
        <link rel="icon" href="/logo.png" type="image/png" />
      </head>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}
      >
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
