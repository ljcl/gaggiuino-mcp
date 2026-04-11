import { Skeleton } from "@gaggiuino/ui";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { extractAnnotations, extractMeta, toChartData } from "./normalize";
import { ShotGraph } from "./ShotGraph";
import type {
  App as McpApp,
  McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ShotData } from "./types";
import "./global.css";

interface ToolArgs {
  shot_id: string;
  compare_shot_id?: string;
}

function parseShotFromResult(result: CallToolResult): ShotData | null {
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as ShotData;
  } catch {
    return null;
  }
}

function extractPhaseBoundaries(shot: ShotData): number[] {
  const {
    targetPressure = [],
    targetPumpFlow = [],
    timeInShot = [],
  } = shot.datapoints;
  const len = Math.max(targetPressure.length, targetPumpFlow.length);
  const raw: number[] = [];

  for (let i = 1; i < len; i++) {
    const flowTransition =
      ((targetPumpFlow[i - 1] ?? 0) === 0) !== ((targetPumpFlow[i] ?? 0) === 0);
    const pressureTransition =
      Math.abs((targetPressure[i] ?? 0) - (targetPressure[i - 1] ?? 0)) > 10;

    if ((flowTransition || pressureTransition) && i < timeInShot.length) {
      raw.push(timeInShot[i] / 10);
    }
  }

  // Deduplicate: keep only the first boundary in each cluster
  const MIN_GAP = 4;
  return raw.filter((t, idx) => idx === 0 || t - raw[idx - 1] >= MIN_GAP);
}

interface AppContentProps {
  app: McpApp;
  toolArgs: ToolArgs;
  safeAreaInsets?: McpUiHostContext["safeAreaInsets"];
  mode: "mobile" | "desktop";
}

function AppContent({ app, toolArgs, safeAreaInsets, mode }: AppContentProps) {
  const [primaryShot, setPrimaryShot] = useState<ShotData | null>(null);
  const [comparisonShot, setComparisonShot] = useState<ShotData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  const fetchShot = useCallback(
    async (shotId: string): Promise<ShotData | null> => {
      const result = await app.callServerTool({
        name: "get_shot_raw_json",
        arguments: { shot_id: shotId },
      });
      return parseShotFromResult(result);
    },
    [app],
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        setError(null);
        const primary = await fetchShot(toolArgs.shot_id);
        if (cancelled) return;
        if (!primary) {
          setError("Failed to load shot data");
          return;
        }
        setPrimaryShot(primary);

        if (toolArgs.compare_shot_id) {
          const comparison = await fetchShot(toolArgs.compare_shot_id);
          if (cancelled) return;
          setComparisonShot(comparison);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [toolArgs.shot_id, toolArgs.compare_shot_id, fetchShot]);

  const handleRequestCompare = useCallback(async () => {
    if (!primaryShot) return;
    setCompareLoading(true);
    setCompareError(null);
    try {
      const prevId = String(Number(primaryShot.id) - 1);
      const shot = await fetchShot(prevId);
      if (shot) {
        setComparisonShot(shot);

        // Build a concise comparison summary for the AI
        const pm = extractMeta(primaryShot);
        const cm = extractMeta(shot);
        const summary = [
          `Shot #${pm.id} (${pm.profileName}): ${pm.weight.toFixed(1)}g in ${pm.duration.toFixed(1)}s`,
          `Shot #${cm.id} (${cm.profileName}): ${cm.weight.toFixed(1)}g in ${cm.duration.toFixed(1)}s`,
        ].join("\n");

        // Provide comparison context for the model's next turn
        app
          .updateModelContext({
            content: [
              {
                type: "text",
                text: `The user is comparing two espresso shots side-by-side in the shot graph:\n${summary}`,
              },
            ],
          })
          .catch(() => {});

        // Send a message to trigger AI analysis
        app
          .sendMessage({
            role: "user",
            content: [
              {
                type: "text",
                text: `I'm now comparing shot #${pm.id} with the previous shot #${cm.id}. Can you briefly analyze the differences between these two shots?`,
              },
            ],
          })
          .catch(() => {});
      } else {
        setCompareError("No previous shot found");
      }
    } catch (err) {
      setCompareError(String(err));
    } finally {
      setCompareLoading(false);
    }
  }, [primaryShot, app, fetchShot]);

  const handleDismissCompare = useCallback(() => {
    setComparisonShot(null);
    setCompareError(null);
  }, []);

  if (loading) {
    return (
      <div style={{ padding: "24px" }}>
        <Skeleton variant="chart" />
      </div>
    );
  }

  if (error || !primaryShot) {
    return (
      <div style={{ padding: "24px", color: "var(--color-text-danger, #c00)" }}>
        {error ?? "No shot data available"}
      </div>
    );
  }

  const chartData = toChartData(primaryShot, comparisonShot ?? undefined);
  const primaryMeta = extractMeta(primaryShot);
  const comparisonMeta = comparisonShot
    ? extractMeta(comparisonShot)
    : undefined;
  const phaseBoundaries = extractPhaseBoundaries(primaryShot);
  const annotations = extractAnnotations(primaryShot);
  const comparisonAnnotations = comparisonShot
    ? extractAnnotations(comparisonShot)
    : undefined;

  // Host-initiated comparison: allow dismiss but not "compare previous"
  const hostInitiatedCompare = !!toolArgs.compare_shot_id;

  const basePad = mode === "mobile" ? { y: 20, x: 16 } : { y: 24, x: 20 };
  return (
    <div
      style={{
        background: "var(--color-background-primary)",
        border: "1px solid var(--color-border-tertiary)",
        borderRadius: "var(--border-radius-lg)",
        paddingTop: `calc(${basePad.y}px + ${safeAreaInsets?.top ?? 0}px)`,
        paddingRight: `calc(${basePad.x}px + ${safeAreaInsets?.right ?? 0}px)`,
        paddingBottom: `calc(${basePad.y}px + ${safeAreaInsets?.bottom ?? 0}px)`,
        paddingLeft: `calc(${basePad.x}px + ${safeAreaInsets?.left ?? 0}px)`,
      }}
    >
      {compareError && (
        <div
          style={{
            padding: "4px 8px",
            fontSize: "var(--font-text-xs-size)",
            color: "var(--color-text-danger, #c00)",
          }}
        >
          {compareError}
        </div>
      )}
      <ShotGraph
        data={chartData}
        primaryMeta={primaryMeta}
        comparisonMeta={comparisonMeta}
        phaseBoundaries={phaseBoundaries}
        annotations={annotations}
        comparisonAnnotations={comparisonAnnotations}
        onRequestCompare={
          hostInitiatedCompare ? undefined : handleRequestCompare
        }
        onDismissCompare={comparisonShot ? handleDismissCompare : undefined}
        compareLoading={compareLoading}
        mode={mode}
      />
    </div>
  );
}

/** Width (in px) below which the shot graph renders in mobile layout. */
const MOBILE_BREAKPOINT_PX = 480;

type HostCtx = Pick<
  McpUiHostContext,
  "platform" | "containerDimensions" | "safeAreaInsets"
>;

function Root() {
  const [toolArgs, setToolArgs] = useState<ToolArgs | null>(null);
  const [hostCtx, setHostCtx] = useState<HostCtx>({});

  const { app, error: connectError } = useApp({
    appInfo: { name: "Shot Graph", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (app) => {
      app.ontoolinput = (input) => {
        const args = input.arguments as ToolArgs | undefined;
        if (args?.shot_id) {
          setToolArgs(args);
        }
      };
      app.onhostcontextchanged = (ctx) => {
        setHostCtx({
          platform: ctx.platform,
          containerDimensions: ctx.containerDimensions,
          safeAreaInsets: ctx.safeAreaInsets,
        });
      };
      app.onerror = console.error;
    },
  });

  useHostStyles(app, app?.getHostContext());

  if (connectError)
    return (
      <div style={{ padding: "24px" }}>
        Connection error: {connectError.message}
      </div>
    );
  if (!app) return <div style={{ padding: "24px" }}>Connecting...</div>;
  if (!toolArgs)
    return <div style={{ padding: "24px" }}>Waiting for shot data...</div>;

  const dims = hostCtx.containerDimensions;
  const widthHint =
    dims && "width" in dims
      ? dims.width
      : dims && "maxWidth" in dims
        ? dims.maxWidth
        : undefined;
  const isMobile =
    hostCtx.platform === "mobile" ||
    (widthHint !== undefined && widthHint < MOBILE_BREAKPOINT_PX);
  const mode: "mobile" | "desktop" = isMobile ? "mobile" : "desktop";

  return (
    <AppContent
      app={app}
      toolArgs={toolArgs}
      safeAreaInsets={hostCtx.safeAreaInsets}
      mode={mode}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
