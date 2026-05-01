type Step = {
  title: string;
  content: React.ReactNode;
};

type StepperProps = {
  steps: Step[];
};

export default function Stepper({ steps }: StepperProps) {
  return (
    <div className="my-8 space-y-6">
      {steps.map((step, index) => (
        <div key={index} className="flex gap-4">
          <div className="shrink-0">
            <div className="w-8 h-8 rounded-full bg-accent text-white flex items-center justify-center text-sm font-bold">
              {index + 1}
            </div>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-text-primary">
              {step.title}
            </h3>
            <div className="mt-1 text-text-secondary">{step.content}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
