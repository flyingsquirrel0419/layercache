import { Navbar } from "@/components/landing/Navbar";
import { Hero } from "@/components/landing/Hero";
import { Features } from "@/components/landing/Features";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Comparison } from "@/components/landing/Comparison";
import { CTA } from "@/components/landing/CTA";
import { WebMCP } from "@/components/landing/WebMCP";

export default function LandingPage() {
  return (
    <main>
      <WebMCP />
      <Navbar />
      <Hero />
      <Features />
      <HowItWorks />
      <Comparison />
      <CTA />
    </main>
  );
}
