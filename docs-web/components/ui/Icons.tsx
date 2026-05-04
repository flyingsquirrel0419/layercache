import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function PlayIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M8 5.14v13.72a1 1 0 0 0 1.5.87l11.88-6.86a1 1 0 0 0 0-1.74L9.5 4.27A1 1 0 0 0 8 5.14Z" />
    </svg>
  );
}
