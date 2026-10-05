// The selected capability's one-hop routes for the map (CORE-47): what it
// uses and what uses it, by imports. Only capabilities get routes: their
// links run to other countries on the map, where a file's or symbol's would
// mostly land inside its own.

import { useEffect, useMemo, useState } from "react";
import type { AtlasEntitySummary } from "../../../shared/atlas.ts";
import type { AtlasReader } from "../../lib/atlas.ts";
import type { MapRoute } from "./AtlasTerritory.tsx";

const NONE: readonly MapRoute[] = [];

export function useMapRoutes(
  reader: AtlasReader,
  entity: AtlasEntitySummary | null,
  snapshot: string | null,
): readonly MapRoute[] {
  // Read once per selection and snapshot: coming back to a capability draws
  // its routes at once, without asking again.
  const known = useMemo(() => new Map<string, readonly MapRoute[]>(), [reader]);
  const [, setVersion] = useState(0);
  const id = entity?.kind === "capability" ? entity.id : null;
  const key = id && snapshot ? `${id}|${snapshot}` : null;
  useEffect(() => {
    if (!id || !snapshot || !key || known.has(key)) return;
    const controller = new AbortController();
    const read = (direction: "out" | "in") =>
      reader
        .relations(id, direction, {
          kind: "depends_on",
          snapshot,
          signal: controller.signal,
          limit: 50,
        })
        .then((page) =>
          page.items.flatMap((r): MapRoute[] => {
            const other = direction === "out" ? r.dst : r.src;
            return other === id ? [] : [{ id: other, direction, weight: r.weight }];
          }),
        );
    Promise.all([read("out"), read("in")]).then(
      ([out, into]) => {
        if (controller.signal.aborted) return;
        known.set(key, [...out, ...into]);
        setVersion((v) => v + 1);
      },
      // Without routes the map is still right; the inspector says why links failed.
      () => undefined,
    );
    return () => controller.abort();
  }, [reader, known, id, snapshot, key]);
  return (key && known.get(key)) || NONE;
}
