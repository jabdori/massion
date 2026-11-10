# Member admission undo and authored replies

R-P implements B21-done-hana and B11-quill in both themes. Browser runtime,
file-read activity, room geometry, payment decisions and approved screen contracts
are outside this change.

New owner admissions explicitly open an undo window on the member. The window
closes durably before the first member turn or Work admission, and on archive or
model-group change. Undo archives the original identity and marks the admission
receipt undone; it never deletes conversations, Work, Records or the home. A
restored member does not regain the window. Legacy admission commands replay
unchanged and have no undo window. Member-use and undo contend on the same
members aggregate revision; a lost write stops admission rather than proceeding.
All owner writes use the drain-aware owner store and existing command receipts.

An owner addressing an exact roster name with a leading @ selects that member's
model group for a direct reply in the Representative conversation. The host pins
its typed id/name before the call; settlement copies that pin onto the message.
A member-authored reply cannot propose Work or steer the Representative thread.
The model cannot select or forge attribution. Existing unaddressed replies and
legacy journal records retain their original shape. The byline reads only the
stored attribution, so archive or roster replacement cannot relabel history.

Verification: failing-first reducer/service and client tests, targeted Node 24
tests and typecheck, both-theme headless browser interactions and screen contracts.
CI owns the full suite. Delivery stops after clean CI and a Codex receipt naming
the final head, without merging, or reports remaining findings after four rounds.

The existing `POST /assistant/members` and receipt query accept action `undo`.
The first-use operation has a reserved host command identity. A pre-upgrade
admission answer is looked up with its original fingerprint before the new
undo-enabled admission is considered. Conversation history retains member pins
as data so a later speaker does not inherit another member's authorship.
