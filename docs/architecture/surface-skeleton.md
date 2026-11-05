# Surface skeleton 1: rail, sidebar, activity and work pane

- Status: implemented (client only, no new host route).
- Date: 2026-11-06, above `feat/family-map-model-groups`
- Decisions: [ADR 0002](decisions/0002-assistant-first-surface-and-independent-checks.md) §1, §2 and §8 as changed by [ADR 0003](decisions/0003-members-internal-teams-model-groups-and-apps.md) ("Changes to ADR 0002", §1), implementation order item 5. Screens: experience plan v3.1 §5.1–§5.5, prototype artboards B2 (default), B9 (activity view) and B7 (work pane).
- Builds on: [Assistant conversation](assistant-conversation.md), [Local Mission/Work interface](product-interface.md)

## Problem

The workbench was one long page: an intro, a column of Mission forms and a column with the Mission detail, with the conversation on top. ADR 0003 puts one fixed frame around everything: a rail, a sidebar of people and their Work, the conversation in the middle and a work pane beside it. This increment builds that frame from the data the client already reads. It adds no host route and no new state.

## Layout

```
[rail] | [sidebar] | [header + page] | [work pane]
```

| Part | Holds | Source |
|---|---|---|
| Rail | Representative (back to the conversation), Results, Schedules, an empty installed-apps slot, and the owner's menu at the bottom with Settings | Static |
| Sidebar, default | The Representative, then an empty members slot, then under the Representative one line per running Work ([surface skeleton 2](conversation-cards.md)) | Work cards of the conversation read |
| Sidebar, activity | One list without group titles or counts. Sort menu: priority (exception → running → done) or recent. Row: bold title, grey state, avatar, unread dot | Same read |
| Header | Sidebar toggle and the page name (the Representative's name on the conversation) | Static |
| Page | The conversation, or a full page: Results, Schedules, Settings | Rail and owner's menu |
| Work pane | Tabs named after the Work, widen, close. The body is the existing Mission and Work detail, the operation status line and durable activity | Existing Mission read |

- Settings holds what used to be the form column: host health, the provider notice, the connection form, Create a Mission, Continue a Mission and the development fixture. Nothing is removed; it moves out of the default view.
- The sync and operation notices stay above the page. They are hidden unless the database changed or a write outcome is unknown, so normal is quiet and exceptions still speak (ADR 0002 §8).
- The intro, the footer and the "Local development" header text are removed. They were explanation sentences.

## Rules

- **One entry to a Work.** A Work card, a sidebar Work line and an activity row all do the same thing: show the conversation, open or select the Work's tab, load its Mission and focus the Work heading.
- **Tabs.** One tab per opened Work, keyed by Mission and Work. Loading a Mission by other means (Continue, create, the fixture, a `#mission=` link) opens one tab for the Mission, named after its purpose, once per Mission change; a background refresh never reopens a closed pane. Closing the last tab hides the pane. The pane shows one Mission at a time because the detail is one Mission snapshot; switching tabs reads the tab's Mission again. A Work tab shows only that Work's card inside the Mission detail; a Mission tab shows every card.
- **Widen** hides the sidebar (its toggle then reads collapsed, and narrowing restores it) and narrows the conversation, so the pane takes the room (the "Show details" view). It is the four-area layout later; today it is the same detail, wider.
- **Explicit opens always show their target.** The catalog, the unresolved Work list, a document use, a Mission link and the load form open the pane even after it was closed or while the same Mission is shown: a named Work gets its own tab, a Mission its Mission tab. Admitting Work switches to the Mission tab so the new card is visible. Only background rereads keep a closed pane closed. While a read or write is in flight, tab selection is ignored, so the tab and the cards below it never disagree.
- **A database change** (new feed) clears the tabs and the unread memory, since neither belongs to the new database.
- **Activity order.** Open decisions come first ([surface skeleton 2](conversation-cards.md)), then exceptions: check failed, stale, blocked, result unknown. A cancellation is the owner's stop, so it counts as done. Then running: working, waiting, not started. Then done. Recent is the reverse conversation order.
- **Unread** is a per-viewer convenience in browser storage: the last state label the viewer saw per Work. A Work seen for the first time records its label without a dot; a later change shows the dot until the Work is opened. Losing the storage only loses dots.
- **Names.** The Representative is drawn with its owner-chosen name. No naming setting exists yet, so the client uses the prototype's 하나. Members do not exist yet; the slot stays empty and hidden, as the experience plan asks for a first-time owner.
- **Words.** The surface keeps the existing English labels and adds only names, page names and state labels. No "assistant", no titles, no explanation sentences. Yellow is not used: the prototype reserves it for decision cards, and the earlier warning notices become neutral.
- **Theme.** The prototype's dark design-system tokens replace the light palette, including inside the existing panels, so the pane and the conversation share one look.

## Accessibility

Landmarks: `nav` for the rail, `aside` for the sidebar, `main` for the page and a labelled region for the work pane. Every icon button has a name. Toggles use `aria-pressed` or `aria-expanded`, menus close on Escape and return focus to their button, tabs use `tablist`/`tab` with `aria-selected`, and the current rail item and sidebar row carry `aria-current`. The unread dot has a text label. ⌘, (Ctrl+, elsewhere) opens Settings.

## Not in this increment

- Profile popover on the header name, `@` completion and the 'Default permissions' chip (step 6 and 7).
- Settings sections (step 9), installed app icons (apps). Results and Schedules content landed in [Results and schedules](results-and-schedules.md).
- Work lines read from the current conversation segment only. Work from older segments or created by other members needs a host Work list query.
- The widened pane does not yet split into the four areas.
