import { type Meta, type StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { CollapseIcon, DownloadIcon, ExpandIcon, RetryIcon } from "./icons";
import { ToolbarButton } from "./ToolbarButton";

const meta: Meta<typeof ToolbarButton> = {
  component: ToolbarButton,
};

export default meta;
type Story = StoryObj<typeof ToolbarButton>;

export const Expand: Story = {
  args: {
    children: <ExpandIcon />,
    label: "Enter fullscreen",
    onClick: fn(),
    pressed: false,
  },
};

export const Collapse: Story = {
  args: {
    children: <CollapseIcon />,
    label: "Exit fullscreen",
    onClick: fn(),
    pressed: true,
  },
};

export const Download: Story = {
  args: {
    children: <DownloadIcon />,
    label: "Export CSV",
    onClick: fn(),
  },
};

export const Disabled: Story = {
  args: {
    children: <DownloadIcon />,
    disabled: true,
    label: "Export CSV",
    onClick: fn(),
  },
};

/** 44px hit area so the button clears mobile touch-target guidelines. */
export const Touch: Story = {
  args: {
    children: <ExpandIcon />,
    label: "Enter fullscreen",
    mode: "mobile",
    onClick: fn(),
  },
};

export const EveryIcon: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 4 }}>
      <ToolbarButton label="Enter fullscreen" onClick={fn()}>
        <ExpandIcon />
      </ToolbarButton>
      <ToolbarButton label="Exit fullscreen" onClick={fn()}>
        <CollapseIcon />
      </ToolbarButton>
      <ToolbarButton label="Export CSV" onClick={fn()}>
        <DownloadIcon />
      </ToolbarButton>
      <ToolbarButton label="Retry" onClick={fn()}>
        <RetryIcon />
      </ToolbarButton>
    </div>
  ),
};

export const DarkTheme: Story = {
  args: {
    children: <ExpandIcon />,
    label: "Enter fullscreen",
    onClick: fn(),
  },
  globals: {
    backgrounds: { value: "dark" },
    hostTheme: "claude",
  },
};
