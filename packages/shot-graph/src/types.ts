export interface ShotDatapoints {
  timeInShot: number[];
  pressure: number[];
  temperature: number[];
  shotWeight: number[];
  weightFlow: number[];
  waterPumped: number[];
  pumpFlow: number[];
  targetPressure: number[];
  targetPumpFlow: number[];
}

export interface ShotProfile {
  name: string;
  waterTemperature?: number;
  globalStopConditions?: {
    weight?: number;
    time?: number;
  };
  phases: Array<{
    type: string;
    stopConditions?: Record<string, number>;
  }>;
}

export interface ShotData {
  id: string;
  duration: number;
  datapoints: ShotDatapoints;
  profile: ShotProfile;
}

/** A single data point for Recharts, with time as X and all series as Y values */
export interface ChartDataPoint {
  time: number;
  pressure?: number;
  targetPressure?: number;
  pumpFlow?: number;
  targetPumpFlow?: number;
  weightFlow?: number;
  shotWeight?: number;
  // Comparison shot series (suffixed with "Cmp")
  pressureCmp?: number;
  targetPressureCmp?: number;
  pumpFlowCmp?: number;
  targetPumpFlowCmp?: number;
  weightFlowCmp?: number;
  shotWeightCmp?: number;
}

/** Metadata displayed in the header above the chart */
export interface ShotMeta {
  id: string;
  profileName: string;
  duration: number;
  weight: number;
}
