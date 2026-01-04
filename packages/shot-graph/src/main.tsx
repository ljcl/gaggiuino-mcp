import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { extractMeta, toChartData } from "./normalize";
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
}

function AppContent({ app, toolArgs, safeAreaInsets }: AppContentProps) {
  const [primaryShot, setPrimaryShot] = useState<ShotData | null>(null);
  const [comparisonShot, setComparisonShot] = useState<ShotData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  if (loading) {
    return (
      <div style={{ padding: "24px", color: "var(--color-text-secondary)" }}>
        Loading shot data...
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

  return (
    <div
      style={{
        paddingTop: safeAreaInsets?.top,
        paddingRight: safeAreaInsets?.right,
        paddingBottom: safeAreaInsets?.bottom,
        paddingLeft: safeAreaInsets?.left,
      }}
    >
      <ShotGraph
        data={chartData}
        primaryMeta={primaryMeta}
        comparisonMeta={comparisonMeta}
        phaseBoundaries={phaseBoundaries}
      />
    </div>
  );
}

function Root() {
  const [toolArgs, setToolArgs] = useState<ToolArgs | null>(null);
  const [safeAreaInsets, setSafeAreaInsets] =
    useState<McpUiHostContext["safeAreaInsets"]>();

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
        if (ctx.safeAreaInsets) {
          setSafeAreaInsets(ctx.safeAreaInsets);
        }
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

  return (
    <AppContent app={app} toolArgs={toolArgs} safeAreaInsets={safeAreaInsets} />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
