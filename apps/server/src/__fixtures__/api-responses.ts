export const mockMachineStatus = {
  temperature: 91,
  targetTemperature: 93,
  pressure: 0,
  weight: 0,
  waterLevel: 85,
  brewSwitchState: "false",
  steamSwitchState: "false",
  profileName: "Zer0",
  upTime: 3600,
};

/**
 * Captured verbatim from a real machine's `/api/system/status` on 2026-07-27.
 * Every numeric field arrives as a decimal *string*, and the switch states as
 * real booleans — the opposite of `mockMachineStatus` above on both counts.
 * Keep this fixture byte-faithful to the firmware: a schema that only satisfies
 * the hand-written fixture passes CI and still fails against hardware.
 */
export const mockMachineStatusFromHardware = {
  upTime: "56",
  profileId: "15",
  profileName: "Zer0",
  targetTemperature: "95.000000",
  temperature: "77.627335",
  pressure: "6.422525",
  waterLevel: "79",
  weight: "-0.100000",
  brewSwitchState: false,
  steamSwitchState: false,
};

export const mockLatestShotResponse = {
  lastShotId: "1706547890",
};

export const mockShotData = {
  id: "1706547890",
  duration: 340,
  datapoints: {
    timeInShot: [0, 100, 200, 300, 340],
    pressure: [20, 50, 91, 85, 62],
    temperature: [910, 910, 910, 910, 910],
    shotWeight: [0, 0, 50, 200, 381],
    weightFlow: [0, 5, 15, 20, 27],
    waterPumped: [0, 100, 300, 450, 547],
    pumpFlow: [40, 35, 25, 20, 15],
    targetPressure: [20, 50, 90, 85, 80],
    targetPumpFlow: [40, 35, 25, 20, 15],
  },
  profile: {
    name: "LMD 9-8 v1.5 (milk)",
    waterTemperature: 91,
    globalStopConditions: {
      weight: 38,
    },
    phases: [
      { type: "FLOW", stopConditions: { time: 5000 } },
      { type: "PRESSURE", stopConditions: { time: 5000 } },
    ],
  },
};

// Shot with temperature drift > 1°C (910 to 925 = 91.0 to 92.5°C)
export const mockShotWithTempDrift = {
  id: "1706547891",
  duration: 340,
  datapoints: {
    timeInShot: [0, 100, 200, 300, 340],
    pressure: [20, 50, 91, 85, 62],
    temperature: [910, 915, 920, 925, 925],
    shotWeight: [0, 0, 50, 200, 381],
    weightFlow: [0, 5, 15, 20, 27],
    waterPumped: [0, 100, 300, 450, 547],
    pumpFlow: [40, 35, 25, 20, 15],
    targetPressure: [20, 50, 90, 85, 80],
    targetPumpFlow: [40, 35, 25, 20, 15],
  },
  profile: {
    name: "Test Profile",
    waterTemperature: 91,
    globalStopConditions: { weight: 38 },
    phases: [],
  },
};

// Shot without target weight
export const mockShotNoTargetWeight = {
  id: "1706547892",
  duration: 340,
  datapoints: {
    timeInShot: [0, 100, 200, 300, 340],
    pressure: [20, 50, 91, 85, 62],
    temperature: [910, 910, 910, 910, 910],
    shotWeight: [0, 0, 50, 200, 381],
    weightFlow: [0, 5, 15, 20, 27],
    waterPumped: [0, 100, 300, 450, 547],
    pumpFlow: [40, 35, 25, 20, 15],
    targetPressure: [20, 50, 90, 85, 80],
    targetPumpFlow: [40, 35, 25, 20, 15],
  },
  profile: {
    name: "No Target Profile",
    waterTemperature: 91,
    globalStopConditions: {},
    phases: [],
  },
};

// Shot with empty datapoints
export const mockShotEmptyDatapoints = {
  id: "1706547893",
  duration: 0,
  datapoints: {},
  profile: {
    name: "Empty Shot",
    waterTemperature: 91,
    globalStopConditions: {},
    phases: [],
  },
};

// Shot with time stop condition and non-scaled datapoints
export const mockShotWithTimeStop = {
  id: "1706547894",
  duration: 300,
  datapoints: {
    timeInShot: [0, 100, 200, 300],
    pressure: [20, 50, 91, 85],
    temperature: [910, 910, 910, 910],
    shotWeight: [0, 50, 200, 350],
    pumpFlow: [40, 35, 25, 20],
    // Non-scaled field for coverage
    customField: [1, 2, 3, 4],
  },
  profile: {
    name: "Time Stop Profile",
    waterTemperature: 91,
    globalStopConditions: { time: 30000 },
    phases: [],
  },
};
