import { useSearchParams } from "react-router";
import { useMediaQuery } from "./hooks";

/** Small windows default to the timer alone. A view change keeps the same timer and task selection mounted. */
export function useFocusView() {
  const [params, setParams] = useSearchParams();
  const smallWindow = useMediaQuery("(max-width: 560px), (max-height: 500px)");
  const view = params.get("view");
  const compact = view === "compact" || (view !== "full" && smallWindow);

  const toggleView = () => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("view", compact ? "full" : "compact");
      return next;
    }, { replace: true });
  };

  return { compact, toggleView };
}
