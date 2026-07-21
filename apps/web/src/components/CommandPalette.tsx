import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { filterPaletteItems, SURFACE_PALETTE_ITEMS, type SurfacePaletteItem } from "@massion/application";

// Web 팔레트 항목도 공통 계약(SURFACE_PALETTE_ITEMS)이 정본입니다 (Phase 30 원칙 13).
// palette parity 테스트가 web surface 항목과 이 action 맵의 일치를 검사합니다.
export const WEB_PALETTE_ITEMS: readonly SurfacePaletteItem[] = SURFACE_PALETTE_ITEMS.filter((item) =>
  item.surfaces.includes("web"),
);

type PaletteNavigate = (options: { readonly to: string }) => void | Promise<void>;

export const WEB_PALETTE_ACTIONS: Readonly<Record<string, (navigate: PaletteNavigate) => void>> = {
  "view.works": (navigate) => void navigate({ to: "/works" }),
  "view.approvals": (navigate) => void navigate({ to: "/approvals" }),
  "view.chat": (navigate) => void navigate({ to: "/works" }),
  "view.overview": (navigate) => void navigate({ to: "/" }),
  "view.agents": (navigate) => void navigate({ to: "/organization" }),
  "view.operations": (navigate) => void navigate({ to: "/access" }),
  "view.subscriptions": (navigate) => void navigate({ to: "/subscriptions" }),
  "work.start": (navigate) => void navigate({ to: "/" }),
  "message.post": (navigate) => void navigate({ to: "/works" }),
  refresh: () => {
    window.location.reload();
  },
  "work.cancel": (navigate) => void navigate({ to: "/works" }),
  "autonomy.toggle": (navigate) => void navigate({ to: "/access" }),
  "workspace.trust": (navigate) => void navigate({ to: "/workspaces" }),
  "workspace.scope.toggle": (navigate) => void navigate({ to: "/works" }),
};

export function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputReference = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((previous) => !previous);
        setQuery("");
        setIndex(0);
      } else if (event.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (open) inputReference.current?.focus();
  }, [open]);

  if (!open) return null;

  const matches = filterPaletteItems(WEB_PALETTE_ITEMS, query).slice(0, 8);

  function run(item: SurfacePaletteItem) {
    setOpen(false);
    WEB_PALETTE_ACTIONS[item.id]?.(navigate);
  }

  return (
    <div
      className="palette-backdrop"
      role="presentation"
      onClick={() => {
        setOpen(false);
      }}
    >
      <div
        className="palette-panel"
        role="dialog"
        aria-modal="true"
        aria-label="명령 팔레트"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <input
          ref={inputReference}
          type="text"
          value={query}
          placeholder="명령 검색…"
          aria-label="명령 검색"
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((previous) => (matches.length ? (previous + 1) % matches.length : 0));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((previous) => (matches.length ? (previous + matches.length - 1) % matches.length : 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const selected = matches[index] ?? matches[0];
              if (selected) run(selected);
            }
          }}
        />
        <ul className="palette-list">
          {matches.length === 0 ? (
            <li className="quiet-line">일치하는 명령이 없습니다.</li>
          ) : (
            matches.map((item, itemIndex) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={itemIndex === index ? "palette-item is-selected" : "palette-item"}
                  onClick={() => {
                    run(item);
                  }}
                >
                  <span>{item.title}</span>
                  <span className="palette-item-meta">
                    {item.category}
                    {item.risky ? " ⚠" : ""}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
        <p className="quiet-line">↑↓ 이동 · Enter 실행 · Esc 닫기</p>
      </div>
    </div>
  );
}
