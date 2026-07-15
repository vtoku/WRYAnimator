// Modal dialogs: a small shared shell (Esc closes, click-outside closes) plus
// the Help > Keyboard shortcuts cheat sheet and About. The cheat sheet is
// generated from the shared SHORTCUTS table so it can never drift from the
// hotkey hints shown in the menus.

import { shortcutGroups } from "./shortcuts.ts";
import { getPref, setPref, applyAppearance, resetPrefs, type Prefs } from "./prefs.ts";

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

// ---- preferences ----------------------------------------------------------

function checkboxRow(parent: HTMLElement, label: string, key: keyof Prefs, onChange?: () => void): void {
  const row = document.createElement("label");
  row.className = "field";
  const span = document.createElement("span");
  span.textContent = label;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = !!getPref(key);
  input.addEventListener("change", () => { setPref(key, input.checked as Prefs[typeof key]); onChange?.(); });
  row.append(span, input);
  parent.appendChild(row);
}

function selectRow(parent: HTMLElement, label: string, key: keyof Prefs, opts: Array<[string, string]>, numeric = false, onChange?: () => void): void {
  const row = document.createElement("label");
  row.className = "field";
  const span = document.createElement("span");
  span.textContent = label;
  const sel = document.createElement("select");
  for (const [value, text] of opts) {
    const o = document.createElement("option");
    o.value = value; o.textContent = text;
    sel.appendChild(o);
  }
  sel.value = String(getPref(key));
  sel.addEventListener("change", () => {
    setPref(key, (numeric ? Number(sel.value) : sel.value) as Prefs[typeof key]);
    onChange?.();
  });
  row.append(span, sel);
  parent.appendChild(row);
}

/** Edit > Preferences: General / Defaults / Appearance, three-tab modal. */
export function openPreferences(): void {
  const body = document.createElement("div");
  body.className = "modal-body";

  const tabsNav = document.createElement("div");
  tabsNav.className = "prefs-tabs";
  const pages = document.createElement("div");

  const defs: Array<[string, (page: HTMLElement) => void]> = [
    ["General", (p) => {
      checkboxRow(p, "Autosave edits per recording", "autosave");
      checkboxRow(p, "Confirm before replacing an unsaved session", "confirmReplace");
      checkboxRow(p, "Show hint (i) tooltips", "showHints", applyAppearance);
    }],
    ["Defaults", (p) => {
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = "Applied to new sessions, never to a recording already open.";
      p.appendChild(note);
      selectRow(p, "Export frame rate", "exportFps", [["30", "30 fps"], ["60", "60 fps"], ["120", "120 fps"]], true);
      selectRow(p, "Bone names", "nameScheme", [["unity", "Unity (HumanBodyBones)"], ["motionbuilder", "MotionBuilder / HumanIK"]]);
      selectRow(p, "Rest pose", "restPose", [["tpose", "T-pose"], ["first", "First frame"]]);
      selectRow(p, "Gizmo space", "gizmoSpace", [["local", "Local"], ["world", "World"]]);
      selectRow(p, "Playback rate", "playbackRate", [["0.25", "0.25x"], ["0.5", "0.5x"], ["1", "1x"], ["2", "2x"]], true);
      checkboxRow(p, "Snapping magnet on", "snapMagnet");
      const h = document.createElement("h4");
      h.className = "group"; h.textContent = "Cleaning on by default";
      p.appendChild(h);
      checkboxRow(p, "Remove pops / flips", "cleanDespike");
      checkboxRow(p, "Smooth jitter", "cleanSmooth");
      checkboxRow(p, "Limit wrists", "cleanLimitWrists");
      checkboxRow(p, "Limit forearm twist", "cleanLimitForearm");
      checkboxRow(p, "Pin planted feet", "cleanFixFeet");
    }],
    ["Appearance", (p) => {
      selectRow(p, "UI scale", "uiScale", [["0.85", "Compact (85%)"], ["1", "Normal (100%)"], ["1.15", "Large (115%)"]], true, applyAppearance);
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = "The accent follows the brand gold. A full theme picker is future work.";
      p.appendChild(note);
    }],
  ];

  const pageEls: HTMLElement[] = [];
  const tabBtns: HTMLButtonElement[] = [];
  defs.forEach(([label, fill], i) => {
    const btn = document.createElement("button");
    btn.className = "prefs-tab" + (i === 0 ? " active" : "");
    btn.textContent = label;
    const page = document.createElement("div");
    page.className = "prefs-page" + (i === 0 ? " active" : "");
    fill(page);
    btn.addEventListener("click", () => {
      tabBtns.forEach((b, j) => b.classList.toggle("active", j === i));
      pageEls.forEach((pg, j) => pg.classList.toggle("active", j === i));
    });
    tabBtns.push(btn);
    pageEls.push(page);
    tabsNav.appendChild(btn);
    pages.appendChild(page);
  });

  body.append(tabsNav, pages);
  const close = openModal("Preferences", body);

  const foot = document.createElement("div");
  foot.className = "rig-row";
  const reset = document.createElement("button");
  reset.className = "button ghost";
  reset.textContent = "Reset to defaults";
  reset.addEventListener("click", () => { resetPrefs(); applyAppearance(); close(); openPreferences(); });
  foot.appendChild(reset);
  pages.appendChild(foot);
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
