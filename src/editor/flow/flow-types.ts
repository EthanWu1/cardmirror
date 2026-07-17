export type FlowFormat = 'ld' | 'pf' | 'policy';

export type FlowSide = 'aff' | 'neg';

export interface FlowCell {
  id: string;
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  backgroundColor?: string;
  updatedAt?: string;
}

export interface FlowColumn {
  id: string;
  label: string;
}

export interface FlowSheet {
  id: string;
  title: string;
  side: FlowSide;
  columns: FlowColumn[];
  rows: FlowCell[][];
  createdAt: string;
  updatedAt: string;
}

export interface FlowRoundSettings {
  defaultFormat: FlowFormat;
  rowCount: number;
  zoomPercent: number;
  layout: {
    flowWidthPercent: number;
    collapsed: boolean;
  };
  colors: {
    aff: string;
    neg: string;
    selection: string;
  };
}

export interface FlowRound {
  id: string;
  flowlineVersion: number;
  title: string;
  format: FlowFormat;
  settings: FlowRoundSettings;
  flows: FlowSheet[];
  createdAt: string;
  updatedAt: string;
}

export interface FlowRange {
  flowId: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface FlowPoint {
  flowId: string;
  row: number;
  col: number;
}
