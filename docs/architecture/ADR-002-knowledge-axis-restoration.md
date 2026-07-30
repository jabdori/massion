# ADR-002 — Restore Knowledge as a Product Axis

[English](ADR-002-knowledge-axis-restoration.md) | [한국어](ADR-002-knowledge-axis-restoration.ko.md)

> **Status:** Accepted
> **Decision date:** 2026-07-27
> **Scope:** Product model and desktop surfaces

## Context

Evidence is one of the responsibilities that survives organizational renaming, but the product model had no surface for questions outside one Work. A Work citation list cannot answer whether a Workspace is indexed, how files relate, or which other Work used the same material.

Knowledge is therefore not a new product identity. It restores an existing organizational responsibility to the product model.

## Decision

### 1. Add Knowledge to the product model

Knowledge answers: **What does the organization know about this Workspace?**

Its primary lineage is Workspace, Repository, IndexVersion, file, document, symbol, relationship, and EvidenceBrief.

### 2. Give Knowledge its own surface

The Knowledge surface is a current Workspace library. The Work Evidence tab is a historical list of what that Work actually cited. Neither can replace the other.

### 3. Use focused graph lenses

The graph presents one node kind at a time instead of mixing every type on one canvas. Work, document, and file views show same-kind relationships; selecting a node opens cross-kind links in a side sheet.

Color comes from folder grouping rather than decoration. Knowledge colors remain quieter than agent identity colors.

The Knowledge graph uses deterministic force layout and direct SVG rendering. Organization remains a hierarchical graph with a different interaction model.

### 4. Open detail as a surface column

Selecting a node opens a right-side sheet inside the surface. It is not an overlay, because overlays are reserved for the global inbox. With no selection, the graph uses the available width.

### 5. Join relationships in the Application layer

Evidence, Organization, and Growth own different relationship stores. The Application layer provides a unified neighbor query without creating a new universal edge table. Native SurrealDB relations, LSP, and an embedding Provider require measured quality or performance evidence before becoming separate architecture changes.

## Consequences

- The desktop navigation includes Knowledge after Work and before Organization.
- The Application contract exposes an index summary, lens graph, and selected-node links.
- The Work Evidence tab remains a Work-scoped consumer of the same relationship lineage.
- Graph controls preserve keyboard navigation and a non-canvas route to each node.

## Rejected alternatives

- **Only a Work tab:** cannot answer Workspace-wide questions.
- **One universal graph:** becomes unreadable as node count grows.
- **Mix every node kind:** removes the meaning of the active lens.
- **Migrate storage before need is measured:** expands the persistence boundary without evidence.
