"use client";

import React, { useRef } from "react";

export type AppTab = "scan" | "diary" | "progress" | "marketplace";

const TABS: { id: AppTab; label: string }[] = [
  { id: "scan", label: "Scan" },
  { id: "diary", label: "Diary" },
  { id: "progress", label: "Progress" },
  { id: "marketplace", label: "Marketplace" },
];

type Props = {
  active: AppTab;
  onChange: (tab: AppTab) => void;
};

export default function TabNav({ active, onChange }: Props) {
  const buttons = useRef<Record<AppTab, HTMLButtonElement | null>>({
    scan: null,
    diary: null,
    progress: null,
    marketplace: null,
  });

  function moveTo(index: number) {
    const next = TABS[(index + TABS.length) % TABS.length];
    onChange(next.id);
    buttons.current[next.id]?.focus();
  }

  return (
    <div className="tab-nav" role="tablist" aria-label="Sections">
      {TABS.map((tab, index) => {
        const selected = active === tab.id;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              buttons.current[tab.id] = node;
            }}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            className="tab-button"
            aria-selected={selected}
            aria-controls={selected ? `panel-${tab.id}` : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                moveTo(index + 1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                moveTo(index - 1);
              } else if (event.key === "Home") {
                event.preventDefault();
                moveTo(0);
              } else if (event.key === "End") {
                event.preventDefault();
                moveTo(TABS.length - 1);
              }
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
