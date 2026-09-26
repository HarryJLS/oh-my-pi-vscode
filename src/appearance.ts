export type TerminalSettings = {
  family: string;
  size: number;
  /** macOS: treat the Option key as Meta (ESC prefix) instead of typing third-level characters. */
  macOptionIsMeta: boolean;
};

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  family: "monospace",
  size: 14,
  macOptionIsMeta: false,
};
