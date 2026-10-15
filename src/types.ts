export type Level = "log" | "info" | "debug" | "warn" | "error";
export interface AuditRule {
  id: string;
  label: string;
  reason: string;
  levels: Level[];
  match:
    | { exact: string }
    | { substring: string }
    | { regex: { source: string; flags?: string } };
  testFiles?: string[];
  origins?: string[];
  live?: boolean;
}
export interface DisplayOptions {
  detail?: "compact" | "detailed";
  githubActions?: "auto" | "on" | "off";
}
export interface AuditConfig {
  schemaVersion: 1;
  rules: AuditRule[];
  failOnUnexpected?: boolean;
  display?: DisplayOptions;
  jsonReport?: string;
  limits?: {
    groups?: number;
    samples?: number;
    messageLength?: number;
    files?: number;
  };
}
export interface Sample {
  message: string;
  origin?: string;
  file: string;
}
export interface Group {
  key: string;
  level: Level;
  ruleId?: string;
  count: number;
  files: string[];
  omittedFiles: number;
  samples: Sample[];
  truncated: number;
}
export interface Snapshot {
  total: number;
  expected: number;
  unexpected: number;
  levels: Record<Level, number>;
  groups: Group[];
  omittedGroups: number;
  usedRules: string[];
}
export interface AuditReport {
  schemaVersion: 1;
  runId: string;
  status: "complete" | "incomplete";
  interrupted: boolean;
  includesRetries: true;
  health: string[];
  capture: {
    executions: number;
    scheduledFiles: number;
    capturedFiles: number;
    affectedFiles: number;
  };
  totals: Snapshot;
  rules: AuditRule[];
  unusedRules: string[];
  limits: Required<NonNullable<AuditConfig["limits"]>>;
}
