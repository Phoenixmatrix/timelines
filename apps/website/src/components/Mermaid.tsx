import { useEffect, useId, useState } from "react";

/** Render a Mermaid diagram. The library is loaded only when a diagram appears. */
export function Mermaid({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        const dark = document.documentElement.getAttribute("data-theme") !== "light";
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif",
          themeVariables: dark
            ? {
                primaryColor: "#2c2824",
                primaryTextColor: "#ece9e4",
                primaryBorderColor: "#4a443d",
                lineColor: "#8f877d",
                background: "transparent",
              }
            : {
                primaryColor: "#f3efe9",
                primaryTextColor: "#2b2620",
                primaryBorderColor: "#cfc7bc",
                lineColor: "#7d756b",
                background: "transparent",
              },
        });
        const { svg: rendered } = await mermaid.render(`mermaid-${id}`, code);
        if (!cancelled) setSvg(rendered);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, id]);

  if (failed) {
    return (
      <pre className="m-0 overflow-x-auto rounded-control bg-sunken p-3 text-body-sm">{code}</pre>
    );
  }
  if (!svg)
    return (
      <div className="h-32 animate-pulse rounded-control bg-sunken" aria-label="Loading diagram" />
    );
  return (
    <div
      className="overflow-x-auto rounded-control bg-sunken p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      // Mermaid's strict security level sanitizes labels; diagrams come from our own graph.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
