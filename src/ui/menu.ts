// Plain-DOM menu bar (File / Edit / View / Help). No library: click a top
// button to open its dropdown, outside-click / Esc closes, arrow keys move
// between items and menus, hotkey hints are right-aligned, and items dim when
// their `enabled` predicate returns false. Item lists are functions so they
// re-evaluate (enabled state, dynamic Recent submenu) every time a menu opens.

export interface MenuItem {
  label?: string;
  /** Right-aligned hotkey hint. */
  hotkey?: string;
  action?: () => void;
  /** Dim (and block) the item when this returns false. */
  enabled?: () => boolean;
  /** Show a check mark when this returns true. */
  checked?: () => boolean;
  /** Horizontal rule instead of an item. */
  separator?: boolean;
  /** Nested flyout (e.g. Recent files). */
  submenu?: () => MenuItem[];
  /** Omit the item entirely when this returns true. */
  hidden?: () => boolean;
}

export interface MenuDef {
  label: string;
  items: () => MenuItem[];
}

/** Build the menu bar into `host`. Returns a closer for the open dropdown. */
export function buildMenuBar(host: HTMLElement, defs: MenuDef[]): { close(): void } {
  host.innerHTML = "";
  host.setAttribute("role", "menubar");
  let openIdx = -1;
  let panel: HTMLElement | null = null;
  const buttons: HTMLButtonElement[] = [];

  function closeMenu() {
    if (panel) { panel.remove(); panel = null; }
    if (openIdx >= 0) buttons[openIdx]?.setAttribute("aria-expanded", "false");
    openIdx = -1;
  }

  function renderPanel(items: MenuItem[], anchor: HTMLElement, parent?: HTMLElement): HTMLElement {
    const p = document.createElement("div");
    p.className = "menu-panel";
    p.setAttribute("role", "menu");
    const rows: HTMLButtonElement[] = [];
    for (const it of items) {
      if (it.hidden?.()) continue;
      if (it.separator) {
        const hr = document.createElement("div");
        hr.className = "menu-sep";
        p.appendChild(hr);
        continue;
      }
      const enabled = it.enabled ? it.enabled() : true;
      const row = document.createElement("button");
      row.className = "menu-item";
      row.setAttribute("role", "menuitem");
      row.disabled = !enabled;
      const check = it.checked?.() ? "✓ " : "";
      const arrow = it.submenu ? "▸" : (it.hotkey ?? "");
      row.innerHTML =
        `<span class="mi-label">${check}${it.label ?? ""}</span>` +
        `<span class="mi-key">${arrow}</span>`;
      if (it.submenu && enabled) {
        let child: HTMLElement | null = null;
        const openChild = () => {
          for (const r of Array.from(p.querySelectorAll<HTMLElement>(".menu-panel"))) r.remove();
          child = renderPanel(it.submenu!(), row, p);
        };
        row.addEventListener("mouseenter", openChild);
        row.addEventListener("click", (e) => { e.stopPropagation(); if (!child) openChild(); });
      } else if (enabled && it.action) {
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          closeMenu();
          it.action!();
        });
      }
      rows.push(row);
      p.appendChild(row);
    }
    // Flyouts anchor to their parent row; top panels to the menu button.
    document.body.appendChild(p);
    const r = anchor.getBoundingClientRect();
    if (parent) {
      p.style.left = `${Math.min(r.right - 2, window.innerWidth - p.offsetWidth - 4)}px`;
      p.style.top = `${Math.min(r.top, window.innerHeight - p.offsetHeight - 4)}px`;
    } else {
      p.style.left = `${Math.min(r.left, window.innerWidth - p.offsetWidth - 4)}px`;
      p.style.top = `${r.bottom + 2}px`;
    }
    (p as unknown as { _rows: HTMLButtonElement[] })._rows = rows;
    return p;
  }

  function openMenu(i: number) {
    closeMenu();
    const def = defs[i];
    if (!def) return;
    openIdx = i;
    buttons[i].setAttribute("aria-expanded", "true");
    panel = renderPanel(def.items(), buttons[i]);
  }

  defs.forEach((def, i) => {
    const btn = document.createElement("button");
    btn.className = "menu-btn";
    btn.type = "button";
    btn.textContent = def.label;
    btn.setAttribute("role", "menuitem");
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (openIdx === i) closeMenu();
      else openMenu(i);
    });
    // Hover switches menus once one is open (classic menu-bar behavior).
    btn.addEventListener("mouseenter", () => { if (openIdx >= 0 && openIdx !== i) openMenu(i); });
    buttons.push(btn);
    host.appendChild(btn);
  });

  // Keyboard navigation across the whole bar.
  function focusablesOf(p: HTMLElement): HTMLButtonElement[] {
    return (p as unknown as { _rows: HTMLButtonElement[] })._rows.filter((r) => !r.disabled);
  }
  document.addEventListener("keydown", (e) => {
    if (openIdx < 0 || !panel) return;
    const rows = focusablesOf(panel);
    const cur = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") { e.preventDefault(); const b = buttons[openIdx]; closeMenu(); b?.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); rows[(cur + 1 + rows.length) % rows.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); rows[(cur - 1 + rows.length) % rows.length]?.focus(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); openMenu((openIdx + 1) % defs.length); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); openMenu((openIdx - 1 + defs.length) % defs.length); }
    else if (e.key === "Enter" || e.key === " ") { (document.activeElement as HTMLButtonElement)?.click(); }
  });

  // Outside click closes.
  window.addEventListener("pointerdown", (e) => {
    const t = e.target as Node;
    if (host.contains(t)) return;
    if (panel && panel.contains(t)) return;
    // A flyout lives in document.body; check any open menu-panel.
    for (const p of Array.from(document.querySelectorAll(".menu-panel"))) if (p.contains(t)) return;
    closeMenu();
  });

  return { close: closeMenu };
}
