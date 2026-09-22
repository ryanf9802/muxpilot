import { useEffect, useId, useState } from "react";
import { CodeBlock } from "./CodeBlock.js";

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

export type MermaidLoader = () => Promise<MermaidApi>;

let defaultMermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!defaultMermaidPromise) {
    defaultMermaidPromise = import("mermaid")
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "dark",
          suppressErrorRendering: true,
          secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges"]
        });
        return mermaid;
      })
      .catch((error) => {
        defaultMermaidPromise = null;
        throw error;
      });
  }
  return defaultMermaidPromise;
}

type RenderState =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "error" };

export function MermaidDiagram({ source, loader = loadMermaid }: { source: string; loader?: MermaidLoader }) {
  const reactId = useId();
  const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [showSource, setShowSource] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [renderState, setRenderState] = useState<RenderState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setRenderState({ status: "loading" });
    void loader()
      .then((mermaid) => mermaid.render(renderId, source))
      .then(({ svg }) => {
        if (active) setRenderState({ status: "ready", svg });
      })
      .catch(() => {
        if (active) setRenderState({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [attempt, loader, renderId, source]);

  const sourceVisible = showSource || renderState.status === "error";
  return (
    <section className="mermaid-diagram" data-state={renderState.status}>
      <div className="mermaid-diagram-toolbar">
        <span>Mermaid diagram</span>
        <button
          type="button"
          onClick={() => {
            if (renderState.status === "error") {
              setAttempt((value) => value + 1);
              return;
            }
            setShowSource((value) => !value);
          }}
        >
          {renderState.status === "error" ? "Retry diagram" : sourceVisible ? "Show diagram" : "Show source"}
        </button>
      </div>
      {sourceVisible ? <CodeBlock text={source} codeClassName="language-mermaid" /> : null}
      {!sourceVisible && renderState.status === "loading" ? (
        <p className="mermaid-diagram-status" role="status">Rendering diagram…</p>
      ) : null}
      {!sourceVisible && renderState.status === "ready" ? (
        <div
          className="mermaid-diagram-canvas"
          role="img"
          aria-label="Mermaid diagram"
          dangerouslySetInnerHTML={{ __html: renderState.svg }}
        />
      ) : null}
      {renderState.status === "error" ? (
        <p className="mermaid-diagram-error" role="alert">Unable to render this Mermaid diagram. Check its syntax and try again.</p>
      ) : null}
    </section>
  );
}
