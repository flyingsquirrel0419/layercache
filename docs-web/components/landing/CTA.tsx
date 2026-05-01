import { AnimatedSection } from "./AnimatedSection";
import Button from "@/components/ui/Button";

export function CTA() {
  return (
    <AnimatedSection className="py-24 px-6 relative overflow-hidden">
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-accent/5 to-transparent" />
      <div className="max-w-3xl mx-auto text-center">
        <h2 className="text-3xl md:text-4xl font-bold mb-4">
          Ready to Cache Smarter?
        </h2>
        <p className="text-text-secondary mb-8">
          Get started with Layercache in minutes. Production-ready caching with
          zero configuration headaches.
        </p>
        <div className="flex items-center justify-center gap-4">
          <Button variant="primary" href="/docs/getting-started">
            Get Started
          </Button>
          <Button
            variant="secondary"
            href="https://github.com/flyingsquirrel0419/layercache"
          >
            View on GitHub
          </Button>
        </div>
      </div>
    </AnimatedSection>
  );
}
