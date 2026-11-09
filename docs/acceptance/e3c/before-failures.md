# Baseline cause classification

Measured before production/fixture edits: **436 / 848 required matches; 450 diagnostics; 24 geometry diagnostics; zero infrastructure errors**. Every contract occurrence is retained in [before-failures.json](before-failures.json). Initial cause attribution can be refined only with source/snapshot evidence. No checker defect has been demonstrated.

| Cause | Occurrences | Evidence / action |
| --- | ---: | --- |
| fixture gap | 204 | Existing navigation/member/read-state paths; fixture does not select the approved thread/activity state or install its app. |
| UI | 124 | src/workbench.ts renderWork and src/surface-shell.ts renderPane retain the legacy detail instead of the Work room. |
| unsupported product capability | 122 | src/domain.ts Task and Attempt have no per-step timestamps; only actual Work ownership/start/end timestamps can be displayed. |

The 12 E3b B4 residual occurrences R006–R011 and R032–R037 (both themes) are tracked separately: remove the legacy pane budget overflow; payment amount slots require actual currency data absent from the host. Recheck B4 alongside this slice.

Baseline geometry failures are pane/main/composer widths in narrow and expanded layouts; fix through existing visual tokens. Infrastructure errors remain blocking.
