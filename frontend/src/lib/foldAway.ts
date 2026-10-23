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
    const added: { item: T; after: string | null }[] = [];
    if (sameList) {
      let after: string | null = null;
      for (const item of seen.items) {
        if (kept.has(item.id)) after = item.id;
        else {
          added.push({ item, after });
          if (added.length > max) {
            added.length = 0;
            break;
          }
        }
      }
    }
    setSeen({ items, scope });
    setGhosts((previous) => [...(sameList ? previous.filter((g) => !kept.has(g.item.id)) : []), ...added]);
  }

  useEffect(() => {
    if (ghosts.length === 0) return;
    const timer = setTimeout(() => setGhosts([]), FOLD_MS);
    return () => clearTimeout(timer);
  }, [ghosts]);

  const after = new Map<string | null, T[]>();
  for (const ghost of ghosts) {
    const group = after.get(ghost.after) ?? [];
    group.push(ghost.item);
    after.set(ghost.after, group);
  }
  const rows: ListRow<T>[] = [];
  const appendGhosts = (anchor: string | null) => {
    for (const item of after.get(anchor) ?? []) rows.push({ item, leaving: true });
    after.delete(anchor);
  };
  appendGhosts(null);
  for (const item of items) {
    rows.push({ item, leaving: false });
    appendGhosts(item.id);
  }
  // An earlier anchor may have left during the animation; its ghosts stay at the end.
  for (const ghost of ghosts) {
    if (after.has(ghost.after)) rows.push({ item: ghost.item, leaving: true });
  }
  return rows;
}
