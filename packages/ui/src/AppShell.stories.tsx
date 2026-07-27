import { type Meta, type StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { AppShell } from "./AppShell";
import { DownloadIcon, ExpandIcon } from "./icons";
import { Skeleton } from "./Skeleton";
import { ToolbarButton } from "./ToolbarButton";

const meta: Meta<typeof AppShell> = {
  component: AppShell,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof AppShell>;

/**
 * Stand-in for whatever an app renders inside the shell, so the stories are
 * about the chrome rather than any one app's content.
 */
function Placeholder() {
  return (
    <div style={{ fontSize: "var(--font-text-sm-size)" }}>
      <div
        style={{
          fontSize: "var(--font-heading-sm-size)",
          fontWeight: "var(--font-weight-semibold)",
        }}
      >
        App content
      </div>
      <p style={{ color: "var(--color-text-secondary)" }}>
        Anything an MCP app renders goes here. The shell owns the card, the
        safe-area padding, and the toolbar row above it.
      </p>
    </div>
  );
}

export const Desktop: Story = {
  args: {
    children: <Placeholder />,
    mode: "desktop",
  },
};

export const Mobile: Story = {
  args: {
    children: <Placeholder />,
    mode: "mobile",
  },
  globals: { viewport: { value: "claudeIosCard" } },
};

/** Host capabilities the app chose to expose, rendered in the toolbar row. */
export const WithActions: Story = {
  args: {
    actions: (
      <>
        <ToolbarButton label="Export CSV" onClick={fn()}>
          <DownloadIcon />
        </ToolbarButton>
        <ToolbarButton label="Enter fullscreen" onClick={fn()} pressed={false}>
          <ExpandIcon />
        </ToolbarButton>
      </>
    ),
    children: <Placeholder />,
    mode: "desktop",
  },
};

/** Touch-sized toolbar buttons on the narrow layout. */
export const MobileWithActions: Story = {
  args: {
    actions: (
      <>
        <ToolbarButton label="Export CSV" mode="mobile" onClick={fn()}>
          <DownloadIcon />
        </ToolbarButton>
        <ToolbarButton label="Enter fullscreen" mode="mobile" onClick={fn()}>
          <ExpandIcon />
        </ToolbarButton>
      </>
    ),
    children: <Placeholder />,
    mode: "mobile",
  },
  globals: { viewport: { value: "claudeIosCard" } },
};

/** iPhone-style insets: the card's padding grows to clear device chrome. */
export const WithSafeAreaInsets: Story = {
  args: {
    children: <Placeholder />,
    mode: "mobile",
    safeAreaInsets: { bottom: 34, left: 0, right: 0, top: 59 },
  },
  globals: { viewport: { value: "iphone16pro" } },
};

/** Fullscreen drops the card treatment and fills the host's viewport. */
export const Fullscreen: Story = {
  args: {
    children: <Placeholder />,
    displayMode: "fullscreen",
    mode: "desktop",
  },
};

/** The shell mid-load, which is what a second app gets for free. */
export const Loading: Story = {
  args: {
    children: <Skeleton />,
    mode: "desktop",
  },
};

export const DarkTheme: Story = {
  args: {
    children: <Placeholder />,
    mode: "desktop",
  },
  globals: {
    backgrounds: { value: "dark" },
    hostTheme: "claude",
  },
};
