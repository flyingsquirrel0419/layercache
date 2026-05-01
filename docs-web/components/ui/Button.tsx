import Link from "next/link";

type ButtonProps = {
  variant?: "primary" | "secondary" | "ghost";
  href?: string;
  className?: string;
  children: React.ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className">;

const variantClasses = {
  primary:
    "bg-accent text-white hover:bg-accent-light shadow-sm",
  secondary:
    "border border-border text-text-primary hover:bg-surface",
  ghost:
    "text-text-secondary hover:text-text-primary",
};

export default function Button({
  variant = "primary",
  href,
  className = "",
  children,
  ...props
}: ButtonProps) {
  const baseClasses =
    "inline-flex items-center justify-center px-5 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150";
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
