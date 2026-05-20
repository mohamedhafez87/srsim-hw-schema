export type MatrixSource = "default_layout" | "supported_hardware";

export type RawHardwareRecord = Record<string, string>;

export interface HardwareModelEntry {
  default_layout?: RawHardwareRecord[];
  supported_hardware?: RawHardwareRecord[];
  supported_values?: Record<string, string[]>;
}

export interface HardwareSchema {
  "$schema"?: string;
  generated_at?: string;
  source?: string;
  models: Record<string, HardwareModelEntry>;
}

export interface MatrixRow {
  model: string;
  source: MatrixSource;
  values: Record<string, string[]>;
}

export interface MatrixEntry {
  chassis: string;
  models: string[];
  rows: MatrixRow[];
}

export interface SrsimMda {
  slot?: string | number;
  type?: string;
}

export interface SrsimXiom {
  slot?: string | number;
  type?: string;
  mda?: SrsimMda[];
}

export interface SrsimComponent {
  slot?: string | number;
  type?: string;
  mda?: SrsimMda[];
  xiom?: SrsimXiom[];
}

export interface SrsimConfig {
  labName: string;
  nodeName: string;
  chassis: string;
  sfm: string;
  components: SrsimComponent[];
}

export interface ValidationIssue {
  source: "yaml" | "schema" | "hardware";
  message: string;
  path?: string;
}

export interface ValidationReport {
  valid: boolean;
  parsed?: unknown;
  issues: ValidationIssue[];
}
