import {
  AppShell,
  CollapseIcon,
  callServerToolData,
  canDownloadFiles,
  DownloadIcon,
  describeToolError,
  downloadTextFile,
  ErrorState,
  ExpandIcon,
  type LayoutMode,
  readToolJson,
  type ShellHostContext,
  Skeleton,
  ToolbarButton,
  useDisplayMode,
  useHostRoot,
  useModelContextSync,
  useServerToolData,
} from "@gaggiuino/ui";
import { type App as McpApp } from "@modelcontextprotocol/ext-apps";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_HIDDEN_SERIES } from "./constants";
import { buildShotContextSummary } from "./contextSummary";
import { shotCsv, shotCsvFilename } from "./csv";
import { extractAnnotations, extractMeta, toChartData } from "./normalize";
import { derivePhaseRegions } from "./phases";
import { ShotGraph } from "./ShotGraph";
import { type ShotData } from "./types";
import "./global.css";

/** App-visibility tool that serves the raw shot JSON this chart plots. */
const RAW_JSON_TOOL = "get_shot_raw_json";

interface ToolArgs {
  shot_id: string;
  compare_shot_id?: string;
}

/**
 * Narrow the host's tool arguments. Returning `null` keeps the app in its
 * "waiting for shot data" state rather than mounting a chart with no shot.
 */
function parseToolArgs(
  args: Record<string, unknown> | undefined,
): ToolArgs | null {
  const shotId = args?.shot_id;
  if (typeof shotId !== "string" || shotId === "") return null;
  const compareId = args?.compare_shot_id;
  return {
    compare_shot_id: typeof compareId === "string" ? compareId : undefined,
    shot_id: shotId,
  };
}

function parseShot(result: CallToolResult, toolName: string): ShotData {
  return readToolJson<ShotData>(result, toolName);
}

interface AppContentProps {
  app: McpApp;
  toolArgs: ToolArgs;
  hostContext: ShellHostContext;
  mode: LayoutMode;
}

function AppContent({ app, toolArgs, hostContext, mode }: AppContentProps) {
  const primary = useServerToolData<ShotData>({
    app,
    arguments: { shot_id: toolArgs.shot_id },
    parse: parseShot,
    toolName: RAW_JSON_TOOL,
  });

  // A comparison the host asked for up front, versus one the user asked for by
  // clicking "Compare previous". They are tracked apart so a failure in either
  // can name itself.
  const hostComparison = useServerToolData<ShotData>({
    app,
    arguments: toolArgs.compare_shot_id
      ? { shot_id: toolArgs.compare_shot_id }
      : null,
    parse: parseShot,
    toolName: RAW_JSON_TOOL,
  });

  const [userComparison, setUserComparison] = useState<ShotData | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [comparisonDismissed, setComparisonDismissed] = useState(false);
  const [hiddenSeries, setHiddenSeries] = useState<ReadonlySet<string>>(
    DEFAULT_HIDDEN_SERIES,
  );

  const { canFullscreen, displayMode, isFullscreen, toggleFullscreen } =
    useDisplayMode(app, hostContext);

  const primaryShot = primary.data;
  const comparisonShot = comparisonDismissed
    ? null
    : (userComparison ?? hostComparison.data);

  const view = useMemo(() => {
    if (!primaryShot) return null;
    return {
      annotations: extractAnnotations(primaryShot),
      chartData: toChartData(primaryShot, comparisonShot ?? undefined),
      comparisonAnnotations: comparisonShot
        ? extractAnnotations(comparisonShot)
        : undefined,
      comparisonMeta: comparisonShot ? extractMeta(comparisonShot) : undefined,
      phases: derivePhaseRegions(primaryShot),
      primaryMeta: extractMeta(primaryShot),
    };
  }, [primaryShot, comparisonShot]);

  const contextSummary = useMemo(
    () =>
      view
        ? buildShotContextSummary({
            annotations: view.annotations,
            comparison: view.comparisonMeta,
            comparisonAnnotations: view.comparisonAnnotations,
            hidden: hiddenSeries,
            primary: view.primaryMeta,
          })
        : null,
    [view, hiddenSeries],
  );
  useModelContextSync(app, contextSummary);

  const handleRequestCompare = useCallback(async () => {
    if (!view) return;
    setCompareLoading(true);
    setCompareError(null);
    try {
      const previousId = String(Number(view.primaryMeta.id) - 1);
      const shot = await callServerToolData(
        app,
        RAW_JSON_TOOL,
        { shot_id: previousId },
        parseShot,
      );
      setComparisonDismissed(false);
      setUserComparison(shot);

      // The model gets the numbers from useModelContextSync; this only asks it
      // to say something about them.
      app
        .sendMessage({
          content: [
            {
              text: `I'm now comparing shot #${view.primaryMeta.id} with the previous shot #${shot.id}. Can you briefly analyze the differences between these two shots?`,
              type: "text",
            },
          ],
          role: "user",
        })
        .catch(() => {});
    } catch (error) {
      setCompareError(describeToolError(error));
    } finally {
      setCompareLoading(false);
    }
  }, [app, view]);

  const handleDismissCompare = useCallback(() => {
    setComparisonDismissed(true);
    setUserComparison(null);
    setCompareError(null);
  }, []);

  const handleExport = useCallback(() => {
    if (!view) return;
    // A declined or cancelled download is a normal outcome of the host's own
    // save dialog, so there is nothing to report back to the user.
    downloadTextFile(app, {
      filename: shotCsvFilename(view.primaryMeta, view.comparisonMeta),
      mimeType: "text/csv",
      text: shotCsv(view.chartData, view.comparisonMeta !== undefined),
    }).catch(() => {});
  }, [app, view]);

  const canExport = canDownloadFiles(app) && view !== null;
  const shell = {
    actions:
      canExport || canFullscreen ? (
        <>
          {canExport && (
            <ToolbarButton
              label="Export CSV"
              mode={mode}
              onClick={handleExport}
            >
              <DownloadIcon />
            </ToolbarButton>
          )}
          {canFullscreen && (
            <ToolbarButton
              label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              mode={mode}
              onClick={toggleFullscreen}
              pressed={isFullscreen}
            >
              {isFullscreen ? <CollapseIcon /> : <ExpandIcon />}
            </ToolbarButton>
          )}
        </>
      ) : undefined,
    displayMode,
    mode,
    safeAreaInsets: hostContext.safeAreaInsets,
  };

  if (primary.status !== "ready" && primary.status !== "error") {
    return (
      <AppShell {...shell}>
        <Skeleton
          message={
            primary.status === "slow"
              ? "Still waiting on the machine…"
              : undefined
          }
        />
      </AppShell>
    );
  }

  if (!view) {
    return (
      <AppShell {...shell}>
        <ErrorState
          message={
            primary.error ?? "The machine returned no data for this shot."
          }
          onRetry={primary.retry}
          title="Couldn't load this shot"
        />
      </AppShell>
    );
  }

  // A failed comparison leaves the primary chart perfectly readable, so it is
  // reported in a banner rather than replacing the view.
  const comparisonFailure = compareError
    ? { message: compareError, onRetry: handleRequestCompare }
    : hostComparison.status === "error" && hostComparison.error
      ? { message: hostComparison.error, onRetry: hostComparison.retry }
      : null;

  // Host-initiated comparison: the user can dismiss it, but "compare previous"
  // would fight the argument the tool was called with.
  const hostInitiatedCompare = toolArgs.compare_shot_id !== undefined;

  return (
    <AppShell {...shell}>
      {comparisonFailure && (
        <ErrorState
          message={comparisonFailure.message}
          onRetry={comparisonFailure.onRetry}
          retrying={compareLoading}
          variant="banner"
        />
      )}
      <ShotGraph
        annotations={view.annotations}
        comparisonAnnotations={view.comparisonAnnotations}
        comparisonMeta={view.comparisonMeta}
        compareLoading={compareLoading}
        data={view.chartData}
        mode={mode}
        onDismissCompare={comparisonShot ? handleDismissCompare : undefined}
        onRequestCompare={
          hostInitiatedCompare ? undefined : handleRequestCompare
        }
        onVisibilityChange={setHiddenSeries}
        phases={view.phases}
        primaryMeta={view.primaryMeta}
      />
    </AppShell>
  );
}

/** Full-bleed message for the states before the chart can exist at all. */
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: "var(--color-text-secondary)", padding: "24px" }}>
      {children}
    </div>
  );
}

function Root() {
  const { app, connectError, hostContext, mode, toolInput } =
    useHostRoot<ToolArgs>({
      appInfo: { name: "Shot Graph", version: "1.0.0" },
      parseToolInput: parseToolArgs,
    });

  if (connectError)
    return <Notice>Connection error: {connectError.message}</Notice>;
  if (!app) return <Notice>Connecting…</Notice>;
  if (!toolInput) return <Notice>Waiting for shot data…</Notice>;

  return (
    <AppContent
      app={app}
      hostContext={hostContext}
      mode={mode}
      toolArgs={toolInput}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
