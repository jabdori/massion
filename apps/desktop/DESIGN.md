---
version: "4.0"
name: "Massion — Collaboration Room"
description: "A local AgentOS where a person reads and intervenes as an agent organization asks, challenges, and hands off work"
colors:
  bg-0: "#0b0c0e"
  bg-1: "#15171a"
  bg-2: "#1b1d20"
  bg-3: "#202225"
  line: "#2b2d30"
  line-strong: "#3a3c3f"
  fg: "#f4f5f7"
  fg-2: "#c8cdd6"
  fg-3: "#a2a8b4"
  fg-4: "#838993"
  agent-0: "#dcdee3"
  agent-1: "#3fc8cb"
  agent-2: "#5dc0ea"
  agent-3: "#85b4f7"
  agent-4: "#ada8f8"
  agent-5: "#c9a0ee"
  agent-6: "#e399da"
  agent-7: "#f398be"
  gate: "#f0bc4b"
  gate-ink: "#241d07"
  gate-wash: "#231d0e"
  gate-border: "#4a3c15"
  halt: "#f5766e"
  emergency: "#e8442e"
typography:
  screen-title:
    fontFamily: "Pretendard Variable, Pretendard, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: "600"
    lineHeight: "24px"
    letterSpacing: "-0.02em"
  detail-title:
    fontFamily: "Pretendard Variable, Pretendard, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: "600"
    lineHeight: "24px"
    letterSpacing: "-0.02em"
  speaker:
    fontFamily: "Pretendard Variable, Pretendard, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: "500"
    lineHeight: "18px"
  body:
    fontFamily: "Pretendard Variable, Pretendard, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: "400"
    lineHeight: "20px"
  label:
    fontFamily: "Pretendard Variable, Pretendard, ui-sans-serif, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: "600"
    lineHeight: "14px"
    letterSpacing: "0.08em"
  figure:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "11px"
    fontWeight: "400"
    lineHeight: "16px"
rounded:
  tag: "3px"
  control: "5px"
  panel: "7px"
  avatar: "5px"
spacing:
  nav-row: "27px"
  message: "13px"
  gutter: "9px"
  pad: "13px"
  section: "16px"
---

# Massion Desktop — Collaboration Room

[English](DESIGN.md) | [한국어](DESIGN.ko.md)

## Core scene

The product's defining scene is a person reading and intervening while agents ask, challenge, and hand work off to one another. Many products show an AI executing. Massion must show an organization taking responsibility.

The Collaboration Room is therefore the center of Work. Message type, participant role, reply and cause lineage, rounds, tokens, and cost are product information rather than decorative transcript metadata.

Dynamic organization also happens in the room: inability to handle Work leads to a proposal, impact review, decision, and a new Organization Version.

The six execution stages are chapter dividers, not the screen skeleton. A room may contain several rounds within one stage. Stages orient the reader; they do not replace collaboration.

The craft baseline is Linear, Claude Code Desktop, and Vercel: compact, aligned, and typographically disciplined. Reject skeuomorphism, mascots, human-face agent avatars, neon glow, decorative gradients, and a timeline grid as the primary view.

## Color

The UI is neutral. Agent color answers one question: **who is speaking?**

Color belongs to agent identity, not role. Parallel agents with the same role still need distinct identities. `agentIdentityToken` assigns deterministic slots so identity survives restart and surface changes.

| Token               | Fixed Core Office identity                                     |
| ------------------- | -------------------------------------------------------------- |
| `agent-0`           | Representative — Atlas                                         |
| `agent-1`           | Context & Strategy — Lyra                                      |
| `agent-2`           | Evidence & Research — Quill                                    |
| `agent-3`           | Governance — Onyx                                              |
| `agent-4`           | Delivery Coordination — Vega                                   |
| `agent-5`           | Assurance — Iris                                               |
| `agent-6`           | Records — Cedar                                                |
| `agent-7`           | Growth — Sage                                                  |
| `agent-provisional` | no color; dashed border for Work-scoped or unapproved identity |
| `user`              | neutral human participant                                      |

Agent colors appear only in avatars, speaker names, the left identity rail, and progress bars. They do not color buttons, panel borders, or backgrounds.

Reserved semantic colors:

- `gate` yellow: a human decision is required;
- `halt` coral: blocked or failed;
- green is not a completion color; completion recedes into neutral text and an explicit state label.

Depth uses `bg-0` through `bg-3` and one-pixel lines. No shadows.

## Typography

Use Pretendard Variable and the system sans-serif stack for Korean and Latin. Use Geist Mono only for checksums, paths, handles, versions, time, token, cost, and revision figures.

All numeric data uses `font-variant-numeric: tabular-nums`. Screen titles remain at or below 16px. Hierarchy comes from weight and color, not oversized headings.

## Layout

The Work shell has four areas:

1. surface rail — 150px;
2. Work list — 242px;
3. collaboration room — flexible; and
4. context — 300px.

The minimum window is 1180×720. At this width the surface rail collapses to icons and context can close. Each area scrolls independently. Density is intentional: 27px navigation rows and 13px message spacing.

### Shared surface rhythm

Surfaces use the same header, list, content, and context rhythm unless breaking it produces measurable readability. Knowledge opens a third sheet only after node selection; otherwise its canvas uses the available width.

| Element         | Value                            |
| --------------- | -------------------------------- |
| List column     | 242px; 264px at 1440px and above |
| Context column  | 300px; 332px at 1440px and above |
| Header band     | 46px across adjacent columns     |
| List padding    | `p-2`; row `px-2.5 py-2`         |
| Content padding | `px-5 py-4`                      |
| Context padding | `p-3`                            |

Headers do not scroll away. Message streams may use 860px; prose uses at most 76ch. Shared skeleton does not imply that every surface has the same reading behavior.

### List grammar

Every list uses header, filter, and rows in that order. Rows are two lines: a title, then state and time. Category belongs in detail, not in every row.

Rows are full width and separated by one-pixel lines. Do not turn each row into a rounded card. Do not use a grid that allows long content to silently expand or clip the column.

After building a list, table, or column, inspect the rendered surface. Source code shows intent; the screen shows the result.

### Organization structure and map

Organization divides structure and map 55:45. The structure is the primary reading path. Selecting in one view preserves zoom and reveals the same node in the other. A `coordinator` is a responsibility, not proof of a department or team type.

## Shapes and depth

- tag: 3px;
- control: 5px;
- panel: 7px;
- avatar: 5px.

Dashed borders are reserved for `scope:"work"` and unapproved state. Approval turns them solid. No other component uses dashed borders decoratively.

## Message grammar

Message types differ through placement and annotation, not background color.

| Type             | Presentation                                     |
| ---------------- | ------------------------------------------------ |
| `question`       | show the recipient                               |
| `answer`         | indent below its question                        |
| `challenge`      | quote the challenged content before the response |
| `change_request` | name the target artifact or task                 |
| `review_request` | show recipient and waiting state                 |
| `proposal`       | attach an impact and rollback block              |
| `decision`       | show final state, signer, and revision           |
| `evidence`       | show attachment and abbreviated checksum         |
| `handoff`        | use a horizontal speaker transition line         |
| `status`         | center neutral text without an avatar            |

An organization proposal shows capability added, expected outcome, impact, and rollback before action buttons. Parent and affected nodes use human names before handles.

Chapter dividers appear only at execution-stage transitions. They do not collapse or contain conversation.

The context column owns participant state, room limits, and shared context references. Do not repeat the same limits in the header.

## Truncation

Never hide the fact that content was truncated.

- Avatar rows use a visible `+N` remainder.
- Item counts state visible and total values, such as `3 / 5`.
- Abbreviated identifiers visibly remain identifiers and expose their meaning through accessible labels.

## Interaction

Cards inside a reading flow are not one large button. Use an explicit `Open` control and keep local approve/reject actions in place. List rows may be full-row selection targets because selecting another row does not destroy the surrounding context.

The inbox is a navigation queue, not the owner of decision evidence. It routes the user to the surface that owns the decision instead of duplicating approval actions.

Approval always follows the same grammar: gate symbol, gate wash, what changes, why, rollback, then actions. Closing the inbox is not resolution.

The right sheet attaches to the edge with a one-pixel divider. It is not a floating card.

Decision actions use fixed labels: `Approve` and `Reject`. The body explains the consequence. Navigation uses an explicit open affordance.

## Human language and identifiers

| Kind                | Example              | Rule                                                                         |
| ------------------- | -------------------- | ---------------------------------------------------------------------------- |
| Organization handle | `evidence-research`  | replace with deterministic human name; keep raw value in accessible metadata |
| Domain enum         | `operator`, `orphan` | map exhaustively to localized product language                               |
| Audit identifier    | `evaluation-0031`    | preserve after a human-readable label in mono, subdued text                  |

Do not make users enter internal identifiers. Do not remove identifiers required for auditability.

## Empty and loading states

Empty states use one sentence that explains the state and one available action. No mascot or decorative illustration.

Loading uses geometry-preserving `bg-2` skeleton blocks. No spinner.

## Do

- Quote the source of a challenge.
- Pair questions and answers through indentation.
- Make handoff visible as a speaker transition.
- Show impact and rollback before organizational change actions.
- Use yellow only when a person is required.
- Distinguish `model-unavailable` from `workspace-untrusted`; they require different action.
- Verify source changes on the actual rendered screen.

## Do not

- ask users for internal identifiers;
- draw agents as human-face avatars;
- move agent collaboration into a secondary sidebar;
- make six stages the primary layout;
- use a timeline grid as the default view;
- color success green;
- use shadows, glow, or decorative gradients; or
- display completion without Assurance.
