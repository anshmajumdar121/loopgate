import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
}

export function IntentReply({ children }: Props) {
  return (
    <div className="inline-block max-w-full bg-white/5 text-zinc-100 px-3 py-1.5 rounded-2xl">
      {children}
    </div>
  );
}