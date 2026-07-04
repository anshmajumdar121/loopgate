import { useState, useRef, useEffect, KeyboardEvent } from "react";

interface Props {
  onSubmit: (message: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function ChatInput({ onSubmit, placeholder, disabled }: Props) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow up to 4 lines (~96px)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, [value]);

  const send = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue("");
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex gap-2 p-2 border-t border-white/10">
      <label htmlFor="chat-input" className="sr-only">
        Ask the chatbot a question
      </label>
      <textarea
        id="chat-input"
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        placeholder={placeholder ?? "Ask me about the task or project…"}
        disabled={disabled}
        className="flex-1 resize-none bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400/60 placeholder:text-zinc-500"
      />
      <button
        type="button"
        onClick={send}
        disabled={disabled || !value.trim()}
        aria-label="Send"
        className="px-3 py-2 rounded-lg bg-sky-500 text-white text-sm font-medium hover:bg-sky-400 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        ▶
      </button>
    </div>
  );
}