/** Type declarations for scripts/smoke-codex-tools-off.mjs (the script itself is plain JavaScript, run by hand). */
import type {CliResult} from '../src/cli-agent-providers.ts';
export interface SmokeJudgement {
  status: 'pass' | 'fail' | 'inconclusive' | 'not-run';
  reasons: string[];
  exitCode: number | null;
  eventTypeCounts: Record<string, number>;
  itemKindCounts: Record<string, number>;
  verdict: {status: string; reason: string};
  errorItems: number;
  /** First 400 characters of the model's answer with the marker token replaced; null when there is no answer. */
  answer: string | null;
  markerLeaked: boolean;
  createdFiles: string[];
  deletedFiles: string[];
  modifiedFiles: string[];
  markerChanged: boolean;
  version: string | null;
  usageLimitLine: string | null;
}
export interface SmokeRunRecord extends CliResult {
  marker: string;
  markerBefore: string;
  markerAfter: string | null;
  dirBefore: Record<string, string>;
  dirAfter: Record<string, string>;
  /** stdout+stderr of one `codex --version` run; the version is read from it, the stream carries none. */
  versionOutput?: string;
}
export declare const ALLOWED_ITEM_KINDS: string[];
export declare function judgeRun(run: SmokeRunRecord): SmokeJudgement;
export declare function overallResult(statuses: SmokeJudgement['status'][]): 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'NOT RUN (usage limit)';
export declare function snapshotDir(dir: string): Record<string, string>;
