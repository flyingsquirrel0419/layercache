import Link from "next/link";

type ButtonProps = {
  variant?: "primary" | "secondary" | "ghost";
  href?: string;
  className?: string;
  children: React.ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className">;

const variantClasses = {
  primary:
    "bg-black text-white hover:bg-[#2a2a2a] focus-visible:shadow-[inset_0_0_0_2px_rgb(255,255,255)]",
  secondary:
    "bg-white text-black hover:bg-[#e2e2e2] shadow-[rgba(0,0,0,0.16)_0px_2px_8px_0px]",
  ghost:
    "bg-[#efefef] text-black hover:bg-[#e2e2e2]",
};

export default function Button({
  variant = "primary",
  href,
  className = "",
  children,
  ...props
}: ButtonProps) {
  const baseClasses =
    "inline-flex min-h-11 items-center justify-center px-4 py-2.5 rounded-full text-sm font-medium transition-colors duration-150";
  const classes = `${baseClasses} ${variantClasses[variant]} ${className}`.trim();

  if (href) {
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }

  return (
    <button className={classes} {...props}>
      {children}
    </button>
  );
}
