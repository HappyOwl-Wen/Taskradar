import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { QuickParse } from "./types";

/** Debounced, revision-scoped requests. Submit shares pending work, but refreshes an older result. */
export function useQuickTaskParse() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<QuickParse | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const current = useRef({ text: "", revision: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const composing = useRef(false);
  const pending = useRef<{ revision: number; promise: Promise<QuickParse | null> } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.current.revision += 1;
      clearTimeout(timer.current);
    };
  }, []);

  const parse = (): Promise<QuickParse | null> => {
    const { text: sentence, revision } = current.current;
    if (!sentence) return Promise.resolve(null);
    if (pending.current?.revision === revision) return pending.current.promise;
    let timeout: ReturnType<typeof setTimeout>;
    const promise = Promise.race([
      api.quickParse(sentence),
      new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), 4000); }),
    ]).catch(() => null).then((parsed) => {
      clearTimeout(timeout);
      if (!mounted.current || revision !== current.current.revision) return null;
      setResult(parsed);
      setUnavailable(!parsed);
      return parsed;
    }).finally(() => {
      if (pending.current?.revision === revision) pending.current = null;
    });
    pending.current = { revision, promise };
    return promise;
  };

  const onText = (value: string) => {
    setText(value);
    const sentence = value.trim();
    if (sentence === current.current.text) return;
    current.current = { text: sentence, revision: current.current.revision + 1 };
    clearTimeout(timer.current);
    setResult(null);
    setUnavailable(false);
    if (sentence && !composing.current) timer.current = setTimeout(() => void parse(), 250);
  };

  return {
    text, result, unavailable, onText,
    flush: () => { clearTimeout(timer.current); return parse(); },
    onCompositionStart: () => { composing.current = true; clearTimeout(timer.current); },
    onCompositionEnd: () => {
      composing.current = false;
      clearTimeout(timer.current);
      if (current.current.text) timer.current = setTimeout(() => void parse(), 250);
    },
  };
}
