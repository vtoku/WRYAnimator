// Viewport aid strip: a slim icon toggle column docked top-right over the
// preview canvas — Motion paths / Onion skin / Clean playback. Click toggles
// the aid; the chevron (or right-click / long-press) opens a popover with its
// parameters. All state lives in prefs, so the View menu items and this strip
// stay in sync by construction (both read/write the same keys and this strip
// re-renders on any prefs change).

import { ICONS } from "./icons.ts";
import { getPref, setPref, onPrefsChange, type Prefs } from "./prefs.ts";

type AidKey = "aidPaths" | "aidOnion" | "aidSilhouette" | "aidCleanPlay";

interface ParamDef {
  key: keyof Prefs;
  label: string;
  kind: "range" | "check";
  min?: number;
  max?: number;
  step?: number;
  /** range only: pref value -> display string. */
  fmt?: (v: number) => string;
  /** range only: pref <-> slider scaling (e.g. opacity 0-1 on a 5-90 slider). */
  toSlider?: (v: number) => number;
  fromSlider?: (v: number) => number;
}

interface AidDef {
  key: AidKey;
  label: string;
  icon: string;
  params: ParamDef[];
}

const AIDS: AidDef[] = [
  {
    key: "aidPaths",
    label: "Motion paths",
    icon: ICONS.motionpath,
    params: [
      { key: "aidPathWindow", label: "Window ±frames", kind: "range", min: 10, max: 300, step: 10, fmt: (v) => String(v) },
      { key: "aidPathDots", label: "Frame dots", kind: "check" },
    ],
  },
  {
    key: "aidOnion",
    label: "Onion skin",
    icon: ICONS.onionskin,
    params: [
      { key: "aidOnionCount", label: "Ghosts each side", kind: "range", min: 1, max: 6, step: 1, fmt: (v) => String(v) },
      { key: "aidOnionStep", label: "Step frames", kind: "range", min: 1, max: 20, step: 1, fmt: (v) => String(v) },
      {
        key: "aidOnionOpacity", label: "Opacity", kind: "range", min: 5, max: 90, step: 5,
        fmt: (v) => `${Math.round(v * 100)}%`,
        toSlider: (v) => Math.round(v * 100),
        fromSlider: (v) => v / 100,
      },
    ],
  },
  { key: "aidSilhouette", label: "Silhouette", icon: ICONS.silhouette, params: [] },
  { key: "aidCleanPlay", label: "Clean playback", icon: ICONS.cleanplay, params: [] },
];

export function createAidStrip(host: HTMLElement, opts?: { onFrame?: () => void }): { dispose(): void } {
  const strip = document.createElement("div");
  strip.className = "aidstrip";
  host.appendChild(strip);

  // Frame character: an ACTION (not a toggle) — camera recovery has to be one
  // click away when root travel walks the character out of view.
  if (opts?.onFrame) {
    const wrap = document.createElement("div");
    wrap.className = "aid-wrap";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "aid-btn";
    btn.title = "Frame character (C)";
    btn.innerHTML = ICONS.frame;
    btn.addEventListener("click", () => opts.onFrame!());
    wrap.appendChild(btn);
    strip.appendChild(wrap);
  }

  let openPop: HTMLElement | null = null;
  const closePop = () => { openPop?.remove(); openPop = null; };

  function buildPop(def: AidDef, wrap: HTMLElement) {
    closePop();
    const pop = document.createElement("div");
    pop.className = "aid-pop";
    const title = document.createElement("div");
    title.className = "aid-pop-title";
    title.textContent = def.label;
    pop.appendChild(title);
    for (const p of def.params) {
      const row = document.createElement("label");
      const span = document.createElement("span");
      span.textContent = p.label;
      row.appendChild(span);
      if (p.kind === "check") {
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = getPref(p.key) as boolean;
        input.addEventListener("change", () => setPref(p.key, input.checked as never));
        row.appendChild(input);
      } else {
        const out = document.createElement("output");
        const input = document.createElement("input");
        input.type = "range";
        input.min = String(p.min); input.max = String(p.max); input.step = String(p.step);
        const toS = p.toSlider ?? ((v: number) => v);
        const fromS = p.fromSlider ?? ((v: number) => v);
        const cur = getPref(p.key) as number;
        input.value = String(toS(cur));
        out.value = p.fmt?.(cur) ?? String(cur);
        input.addEventListener("input", () => {
          const v = fromS(Number(input.value));
          out.value = p.fmt?.(v) ?? String(v);
          setPref(p.key, v as never);
        });
        row.append(input, out);
      }
      pop.appendChild(row);
    }
    wrap.appendChild(pop);
    openPop = pop;
  }

  const buttons = new Map<AidKey, HTMLButtonElement>();
  for (const def of AIDS) {
    const wrap = document.createElement("div");
    wrap.className = "aid-wrap";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "aid-btn";
    btn.title = def.label;
    btn.innerHTML = def.icon;
    btn.addEventListener("click", () => setPref(def.key, !getPref(def.key)));
    wrap.appendChild(btn);
    buttons.set(def.key, btn);
    if (def.params.length) {
      const chev = document.createElement("button");
      chev.type = "button";
      chev.className = "aid-chev";
      chev.title = `${def.label} settings`;
      chev.textContent = "‹";
      chev.addEventListener("click", (e) => {
        e.stopPropagation();
        if (openPop?.parentElement === wrap) closePop();
        else buildPop(def, wrap);
      });
      // Right-click the main button also opens the params (long-press proxy).
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        buildPop(def, wrap);
      });
      wrap.appendChild(chev);
    }
    strip.appendChild(wrap);
  }

  function refresh() {
    for (const def of AIDS) buttons.get(def.key)!.classList.toggle("active", !!getPref(def.key));
  }
  refresh();
  const unsub = onPrefsChange(refresh);

  const onOutside = (e: PointerEvent) => {
    if (openPop && !strip.contains(e.target as Node)) closePop();
  };
  window.addEventListener("pointerdown", onOutside);

  return {
    dispose() {
      unsub();
      window.removeEventListener("pointerdown", onOutside);
      strip.remove();
    },
  };
}
