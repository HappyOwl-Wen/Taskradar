import { useEffect, useState } from "react";

/** As long as the fold-away animation (.motion-row-out in index.css), plus a little. */
const FOLD_MS = 260;

export interface ListRow<T> {
  item: T;
  /** The row has left the list and is folding away; it takes no clicks. */
  leaving: boolean;
}

/**
 * Rows that just left a list (ticked off, decided) stay a moment longer and fold away, so the rows below move up
 * instead of jumping. Only a few rows leaving the same list animate; another view, filter or order (`scope`)
 * shows at once.
 */
export function useFoldAway<T extends { id: string }>(items: T[], scope: string, max = 5): ListRow<T>[] {
  const [seen, setSeen] = useState({ items, scope });
  const [ghosts, setGhosts] = useState<{ item: T; after: string | null }[]>([]);

  if (seen.items !== items || seen.scope !== scope) {
    const kept = new Set(items.map((i) => i.id));
    const sameList = seen.scope === scope;
    const gone = sameList ? seen.items.filter((i) => !kept.has(i.id)) : [];
    const added =
      gone.length > 0 && gone.length <= max
        ? gone.map((item) => {
            // Shown after the nearest earlier row that is still there (or first).
            const index = seen.items.indexOf(item);
            const before = seen.items.slice(0, index).reverse().find((i) => kept.has(i.id));
            return { item, after: before?.id ?? null };
          })
        : [];
    setSeen({ items, scope });
    setGhosts((previous) => [...(sameList ? previous.filter((g) => !kept.has(g.item.id)) : []), ...added]);
  }

  useEffect(() => {
    if (ghosts.length === 0) return;
    const timer = setTimeout(() => setGhosts([]), FOLD_MS);
    return () => clearTimeout(timer);
  }, [ghosts]);

  const rows: ListRow<T>[] = items.map((item) => ({ item, leaving: false }));
  const placed = new Map<string | null, number>(); // ghosts already put after each row, to keep their order
  for (const ghost of ghosts) {
    const anchor = ghost.after === null ? -1 : rows.findIndex((r) => r.item.id === ghost.after);
    const offset = placed.get(ghost.after) ?? 0;
    const at = ghost.after !== null && anchor < 0 ? rows.length : anchor + 1 + offset;
    placed.set(ghost.after, offset + 1);
    rows.splice(at, 0, { item: ghost.item, leaving: true });
  }
  return rows;
}
