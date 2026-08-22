import { type Meta, type StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { ErrorState } from "./ErrorState";

const meta: Meta<typeof ErrorState> = {
  component: ErrorState,
};

export default meta;
type Story = StoryObj<typeof ErrorState>;

/** The wording the server actually sends when the machine cannot be reached. */
const MACHINE_UNREACHABLE =
  "Could not reach the Gaggiuino machine at http://gaggiuino.local. The machine may be powered off, asleep, or unreachable on the network. Ask the user to check that it is turned on and connected.";

/** The wording the server sends when a shot id has aged out of history. */
const SHOT_EXPIRED =
  "No shot with id '1706547890' exists on the machine. Gaggiuino keeps only a limited shot history, so older ids expire. Call get_latest_shot_id to get the id of the most recent shot, then retry.";

export const MachineUnreachable: Story = {
  args: {
    message: MACHINE_UNREACHABLE,
    onRetry: fn(),
    title: "Couldn't load this shot",
  },
};

export const ShotExpired: Story = {
  args: {
    message: SHOT_EXPIRED,
    onRetry: fn(),
    title: "Couldn't load this shot",
  },
};

/** No retry affordance for a failure retrying cannot fix. */
export const WithoutRetry: Story = {
  args: {
    message: "get_shot_raw_json returned a response this app could not read.",
  },
};

export const Retrying: Story = {
  args: {
    message: MACHINE_UNREACHABLE,
    onRetry: fn(),
    retrying: true,
    title: "Couldn't load this shot",
  },
};

/**
 * The banner variant: the comparison shot failed to load, but the primary
 * chart is still on screen and still useful.
 */
export const Banner: Story = {
  args: {
    message: MACHINE_UNREACHABLE,
    onRetry: fn(),
    variant: "banner",
  },
};

export const BannerWithoutRetry: Story = {
  args: {
    message: "No previous shot found — this is the oldest shot on the machine.",
    variant: "banner",
  },
};

export const DarkTheme: Story = {
  args: {
    message: MACHINE_UNREACHABLE,
    onRetry: fn(),
    title: "Couldn't load this shot",
  },
  globals: {
    backgrounds: { value: "dark" },
    hostTheme: "claude",
  },
};

/**
 * Clicking retry re-runs the fetch and clears the error.
 */
export const RetrySucceeds: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Retry" }));
    await expect(await canvas.findByText("Loaded on retry")).toBeVisible();
  },
  render: () => {
    const [failed, setFailed] = useState(true);
    if (!failed) return <div>Loaded on retry</div>;
    return (
      <ErrorState
        message={MACHINE_UNREACHABLE}
        onRetry={() => setFailed(false)}
        title="Couldn't load this shot"
      />
    );
  },
};
