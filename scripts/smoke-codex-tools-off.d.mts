/** Type declarations for scripts/smoke-codex-tools-off.mjs (the script itself is plain JavaScript, run by hand). */
export interface SmokeJudgement {
  status: 'pass' | 'fail' | 'inconclusive' | 'not-run';
  reasons: string[];
  exitCode: number | null;
  eventTypeCounts: Record<string, number>;
  itemKindCounts: Record<string, number>;
  verdict: {status: string; reason: string; errorItems: number};
  errorItems: number;
  markerLeaked: boolean;
  createdFiles: string[];
  deletedFiles: string[];
  modifiedFiles: string[];
  markerChanged: boolean;
  version: string | null;
  usageLimitLine: string | null;
}
export interface SmokeRunRecord {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  marker: string;
  markerBefore: string;
  markerAfter: string;
  dirBefore: Record<string, string>;
  dirAfter: Record<string, string>;
}
export declare const ALLOWED_ITEM_KINDS: string[];
export declare function judgeRun(run: SmokeRunRecord): SmokeJudgement;
export declare function overallResult(statuses: SmokeJudgement['status'][]): 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'NOT RUN (usage limit)';
