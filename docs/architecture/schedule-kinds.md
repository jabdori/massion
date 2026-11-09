# Owner-created schedule kinds

R-E extends the existing schedules aggregate and host scheduler. Existing briefing commands and journal snapshots replay unchanged. The briefing remains a singleton; other templates can have independent owner-created schedules, bounded to 30 schedules and 30 retained runs each.

Templates cover the B17-empty weekly expenses, price watch, month-end subscriptions, meeting preparation and Friday groceries, plus the B17 weekly review. Weekly slots use the owner's fixed UTC offset; subscriptions run on the last calendar day; meeting preparation uses an explicit future one-time timestamp. Owner-authored title/request override the template defaults without granting tool, payment or sending permission.

Non-briefing runs submit the retained request through the existing Representative conversation and normal Work admission/checking path. An exported producer adapter accepts the host's AssistantService; the server must inject it as the fifth SchedulesService constructor argument. A run records only the exact resulting Work-bearing turn and segment, never an accepted result or invented data. Missing providers/inputs fail normally; an uncertain producer response remains started and becomes unknown at its deadline, without retry. A completed schedule run means its request produced Work, not that the Work passed Assurance.

Owner commands use ownerStore; admitted run settlement uses the host store. Receipt lookup follows state load, and an idempotency conflict is reconciled by original identity. Only a fresh start invokes a producer. Expired/closed starts cannot produce again. Backup replay validates new fields through the same reducer.

The client keeps selection by schedule ID, invalidates reads/actions on feed replacement, rereads deadlines without events, and discards out-of-order responses. Past runs always open the Representative's exact retained segment even when another member thread was selected.

Implementation/verification: failing reducer/service/adapter/client tests first, then existing command and rendering patterns, then only the affected local tests. All provider replies and storage races are controlled fixtures. No full suite, aggregate checks, real providers or external network tests.

The normal server injects scheduleWorkProducer(assistant). B17 fixtures obtain the additional schedules from actual create/read commands; fixed UI copy lives in copy.ko.json. Browser coverage includes owner creation, persistence, pause and resume. A feed read overtaking the post-create readback cannot strand the creation form: selection derives from the committed receipt without replacing newer list data.

## Integration contract

The legacy create body without `kind` still creates the fixed briefing. New create bodies add one of `weekly-expenses`, `weekly-review`, `price-watch`, `monthly-subscriptions`, `meeting-preparation`, or `weekend-groceries`; `title` and `request` are optional owner-authored overrides. Meeting preparation also requires `onceAt`, an exact future timestamp, and defaults to one run in the client. An explicit malformed kind never falls back to briefing. A fresh request must fit the existing 4 KiB conversation limit including the localized dispatch prefix; this service admission check follows receipt lookup so old receipts remain replayable.

The read response adds `kind` to each schedule. Existing fields stay unchanged: `id`, `title`, `request`, `assignee`, `destination`, `active`, `nextAt`, `minute`, `offset`, `budget: {runs, used}`, and newest-first `runs`. Completed Work-producing runs carry the exact `segment` and `turnIds`; a running run carries `deadlineAt`. Weekly-review titles supplied by the owner name the subject: the sidebar adds the existing review suffix. Pricing titles/requests must come from owner input; no fixture or producer invents a product, observed price or threshold.

The six B17-empty cards retain the approved composite button copy. The parent-owned `ui.schedules.*` keys provide kind titles/requests, weekly/month-end/one-time cycles, Work-run facts and the retained dispatch prefix. Weekly sidebar rows split title, date and cycle into text fragments while retaining the contract's accessible button name. Screen fixtures should use real `SchedulesService.read()` values and real conversation turn sources; final integrated browser/contract checks remain with the integration owner.

A confirmed source returned by the original non-briefing producer can finish its still-started run after the observation deadline. This reconciles the original request's reply without calling the producer again, retaining exact turn IDs and segment. An owner-closed run stays closed. Existing briefing deadline and journal transitions remain unchanged.
