import { AnimatedSection } from "./AnimatedSection";
import Button from "@/components/ui/Button";
import { GithubIcon } from "@/components/ui/Icons";

export function CTA() {
  return (
    <AnimatedSection className="bg-black px-4 py-16 text-white sm:px-6">
      <div className="uber-container">
        <div className="grid gap-8 md:grid-cols-[1fr_auto] md:items-end">
          <div>
            <img src="/logo.png" alt="Layercache" className="mb-8 h-14 w-40 object-contain object-left" />
            <h2 className="max-w-2xl text-4xl font-bold leading-[1.22]">
              Put a disciplined cache stack in front of your slow paths.
            </h2>
            <p className="mt-4 max-w-xl text-base leading-6 text-[#afafaf]">
              Start with memory. Add Redis, disk, invalidation, and metrics when
              production needs them. Keep the same API.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row md:flex-col">
            <Button variant="secondary" href="/docs/getting-started">
              Get started
            </Button>
            <Button
              variant="secondary"
              href="https://github.com/flyingsquirrel0419/layercache"
              className="gap-2"
            >
              <GithubIcon className="h-4 w-4" />
              GitHub
            </Button>
          </div>
        </div>
      </div>
    </AnimatedSection>
  );
}
