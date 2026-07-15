// Modal dialogs: a small shared shell (Esc closes, click-outside closes) plus
// the Help > Keyboard shortcuts cheat sheet and About. The cheat sheet is
// generated from the shared SHORTCUTS table so it can never drift from the
// hotkey hints shown in the menus.

import { shortcutGroups } from "./shortcuts.ts";

/** Open a modal with the given title and body. Returns a close function. */
export function openModal(title: string, body: HTMLElement, opts?: { wide?: boolean }): () => void {
  const back = document.createElement("div");
  back.className = "modal-back";
  const dialog = document.createElement("div");
  dialog.className = "modal" + (opts?.wide ? " modal-wide" : "");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", title);

  const head = document.createElement("div");
  head.className = "modal-head";
  const h = document.createElement("h2");
  h.textContent = title;
  const x = document.createElement("button");
  x.className = "modal-x";
  x.setAttribute("aria-label", "Close");
  x.textContent = "×";
  head.append(h, x);

  dialog.append(head, body);
  back.appendChild(dialog);
  document.body.appendChild(back);

  const close = () => {
    back.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onKey);
  x.addEventListener("click", close);
  back.addEventListener("pointerdown", (e) => { if (e.target === back) close(); });
  return close;
}

/** Help > Keyboard shortcuts: the whole SHORTCUTS table, grouped. */
export function openShortcuts(): void {
  const body = document.createElement("div");
  body.className = "modal-body shortcuts-body";
  for (const g of shortcutGroups()) {
    const section = document.createElement("div");
    section.className = "shortcut-group";
    const h = document.createElement("h3");
    h.textContent = g.group;
    section.appendChild(h);
    const dl = document.createElement("dl");
    dl.className = "shortcut-list";
    for (const s of g.items) {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = s.label;
      const dd = document.createElement("dd");
      const kbd = document.createElement("kbd");
      kbd.textContent = s.keys;
      dd.appendChild(kbd);
      row.append(dt, dd);
      dl.appendChild(row);
    }
    section.appendChild(dl);
    body.appendChild(section);
  }
  openModal("Keyboard shortcuts", body, { wide: true });
}

/** Help > About: version, credit line, repo link. */
export function openAbout(version: string): void {
  const body = document.createElement("div");
  body.className = "modal-body about-body";
  body.innerHTML = `
    <p class="logo"><span class="logo-wry">WRY</span><span class="logo-anim">Animator</span></p>
    <p>Version ${version}</p>
    <p class="note">Edit and clean up Warudo motion capture in your browser, then
      export to FBX, VRMA, or wanim. Everything runs locally; nothing is uploaded.</p>
    <p class="note">Unofficial tool, not affiliated with Warudo / HakuyaLabs.
      Face overlay by Face Cap / Bannaflak.</p>
    <p><a href="https://github.com/vtoku/WRYAnimator" target="_blank" rel="noopener">github.com/vtoku/WRYAnimator</a></p>
  `;
  openModal("About", body);
}
