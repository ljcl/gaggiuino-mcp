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

/**
 * `GET /api/profile/15` exactly as `docs/upstream/rest-api.md` L54-69 documents
 * it, byte-for-byte.
 *
 * This is the **only** fixture the upload round-trip test may use: it is what
 * the reference says the machine serves, so anything the strict upload schema
 * rejects here is a real incompatibility rather than a tolerance case.
 * `mockProfileDefinitionFull` below is for tolerance and rendering.
 */
export const mockProfileDefinition = {
  globalStopConditions: { time: 40000, weight: 36 },
  name: "18g Double",
  phases: [
    {
      name: "Preinfusion",
      restriction: 0,
      skip: false,
      stopConditions: { pressureAbove: 4, time: 10000 },
      target: { curve: "LINEAR", end: 3, time: 5000 },
      type: "PRESSURE",
    },
  ],
  recipe: { coffeeIn: 18, coffeeOut: 36, ratio: 2 },
  waterTemperature: 93,
};

/**
 * A superset carrying the fields `ProfileDto`/`TransitionDto`/`PhaseDto`/
 * `GlobalStopConditionsDto` (websocket.md L188-211) define but the REST example
 * elides, plus a stop condition this server has never heard of.
 *
 * Exercises tolerance and rendering: a skipped phase, a per-phase temperature
 * override, a non-zero restriction, upstream's own `switchToManuaFlowCtrl`
 * misspelling, and the unknown-key passthrough. Must **never** be fed to the
 * strict upload schema — `someFutureCondition` would fail it, and that failure
 * would be a false alarm pushing someone to loosen the one schema that has to
 * stay strict.
 */
export const mockProfileDefinitionFull = {
  globalStopConditions: {
    switchToManuaFlowCtrl: true,
    switchToManualPressureCtrl: false,
    time: 40000,
    waterPumped: 120,
    weight: 36,
  },
  name: "Lever Sim",
  phases: [
    {
      name: "Preinfusion",
      restriction: 0,
      skip: false,
      stopConditions: { pressureAbove: 4, time: 10000 },
      target: { curve: "LINEAR", end: 3, start: 0, time: 5000 },
      type: "PRESSURE",
    },
    {
      name: "Decline",
      restriction: 6,
      skip: true,
      stopConditions: { someFutureCondition: 7, time: 25000, weight: 30 },
      target: { curve: "EASE_OUT", end: 2, time: 20000 },
      type: "FLOW",
      waterTemperature: 91,
    },
  ],
  recipe: { coffeeIn: 18, coffeeOut: 36, ratio: 2 },
  waterTemperature: 93,
};

/** A firmware that sends almost nothing — the null side of every fallback. */
export const mockSparseProfileDefinition = { name: "Bare" };

/**
 * `GET /api/settings` as the reference documents it — the `system` section
 * copied byte-for-byte from `docs/upstream/rest-api.md` L179-196, nested inside
 * the aggregate shape at L112-122.
 *
 * The two tokens and the MQTT password are the point of the fixture, not
 * incidental detail: this is what `get_machine_settings` used to print straight
 * into model context. Keep it faithful to the reference for the same reason
 * `mockMachineStatusFromHardware` is kept faithful to hardware — a fixture
 * invented by hand passes CI and still leaks against real firmware.
 */
export const mockMachineSettingsFromDocs = {
  boiler: { steamSetPoint: 145, offsetTemp: 5, hpwr: 1200 },
  system: {
    pumpFlowAtZero: 0.5,
    timezoneOffsetMinutes: -300,
    sprofilerToken: "abc123xyz",
    visualizerToken: "def456uvw",
    servicesState: true,
    wifiEnabled: true,
    releaseChannel: 0,
    mqttEnabled: false,
    mqttHost: "",
    mqttPort: 1883,
    mqttUsername: "",
    mqttPassword: "",
    mqttTopicPrefix: "gaggiuino",
  },
  scales: {
    forcePredictive: "false",
    hwScalesEnabled: "true",
    hwScalesF1: 1000,
  },
  versions: {
    coreVersion: "a06f97fd",
    frontVersion: "a06f97fd",
    staticVersion: "a06f97fd",
  },
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
