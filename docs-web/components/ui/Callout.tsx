type CalloutType = "info" | "warning" | "tip";

type CalloutProps = {
  type?: CalloutType;
  title?: string;
  children: React.ReactNode;
};

const calloutConfig: Record<
  CalloutType,
  { border: string; bg: string; icon: string }
> = {
  info: {
    border: "border-blue-500",
    bg: "bg-blue-50 dark:bg-blue-500/10",
    icon: "\u2139\uFE0F",
  },
  warning: {
    border: "border-amber-500",
    bg: "bg-amber-50 dark:bg-amber-500/10",
    icon: "\u26A0\uFE0F",
  },
  tip: {
    border: "border-green-500",
    bg: "bg-green-50 dark:bg-green-500/10",
    icon: "\uD83D\uDCA1",
  },
};

export default function Callout({
  type = "info",
  title,
  children,
}: CalloutProps) {
  const config = calloutConfig[type];

  return (
    <div
      className={`my-6 rounded-lg border-l-4 ${config.border} ${config.bg} p-4`}
    >
      <div className="flex items-start gap-2">
        <span className="text-base leading-6 shrink-0">{config.icon}</span>
        <div>
          {title && (
            <p className="font-semibold text-text-primary mb-1">{title}</p>
          )}
          <div className="text-text-secondary text-sm [&>p]:m-0">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
