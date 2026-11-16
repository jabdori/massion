/** Type declarations for scripts/smoke-codex-tools-off.mjs (the script itself is plain JavaScript, run by hand). */
export interface SmokeJudgement {
  status: 'pass' | 'fail' | 'not-run';
  reasons: string[];
  exitCode: number | null;
  eventTypeCounts: Record<string, number>;
  itemKindCounts: Record<string, number>;
  verdict: {status: string; reason: string};
  markerLeaked: boolean;
  newFiles: string[];
  version: string | null;
  usageLimitLine: string | null;
}
export interface SmokeRunRecord {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  marker: string;
  dirBefore: string[];
  dirAfter: string[];
}
export declare const ALLOWED_ITEM_KINDS: string[];
export declare function judgeRun(run: SmokeRunRecord): SmokeJudgement;
