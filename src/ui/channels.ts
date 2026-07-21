// Channel tree for the f-curve editor's Channels mode: body-part groups (with
// the 30 finger bones as first-class rows), a search filter, and multi-select.
// The SAME bone selection is the scope for the curve graph, the filter stack,
// and key reduction — one selection model, three consumers.

export interface ChannelGroup {
  label: string;
  /** Bone names owned directly by this group (Unity HumanBodyBones names). */
  bones: string[];
  children?: ChannelGroup[];
}

/** Build the body-part grouping from the clip's bone-name list. */
export function buildChannelGroups(names: Set<string>): ChannelGroup[] {
  const has = (b: string) => names.has(b);
  const keep = (bs: string[]) => bs.filter(has);
  const finger = (side: "Left" | "Right", name: string, key: string): ChannelGroup => ({
    label: `${side[0]} ${name}`,
    bones: keep([`${side}${key}Proximal`, `${side}${key}Intermediate`, `${side}${key}Distal`]),
  });
  const hand = (side: "Left" | "Right"): ChannelGroup => ({
    label: `${side} hand`,
    bones: keep([`${side}Hand`]),
    children: [
      finger(side, "Thumb", "Thumb"),
      finger(side, "Index", "Index"),
      finger(side, "Middle", "Middle"),
      finger(side, "Ring", "Ring"),
      finger(side, "Little", "Little"),
    ].filter((g) => g.bones.length),
  });
  const groups: ChannelGroup[] = [
    { label: "Root / Hips", bones: keep(["Hips"]) },
    { label: "Spine", bones: keep(["Spine", "Chest", "UpperChest"]) },
    { label: "Head / Neck", bones: keep(["Neck", "Head", "LeftEye", "RightEye", "Jaw"]) },
    { label: "Left arm", bones: keep(["LeftShoulder", "LeftUpperArm", "LeftLowerArm"]) },
    hand("Left"),
    { label: "Right arm", bones: keep(["RightShoulder", "RightUpperArm", "RightLowerArm"]) },
    hand("Right"),
    { label: "Left leg", bones: keep(["LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "LeftToes"]) },
    { label: "Right leg", bones: keep(["RightUpperLeg", "RightLowerLeg", "RightFoot", "RightToes"]) },
  ];
  // Prune empty groups (avatar without fingers, etc.).
  const prune = (g: ChannelGroup): boolean => {
    g.children = (g.children ?? []).filter(prune);
    return g.bones.length > 0 || g.children.length > 0;
  };
  return groups.filter(prune);
}

/** All bone names owned by a group and its descendants. */
export function groupBones(g: ChannelGroup): string[] {
  return [...g.bones, ...(g.children ?? []).flatMap(groupBones)];
}

/** Short display name for a bone row (drops the L/R + spells out fingers). */
export function boneLabel(name: string): string {
  return name
    .replace(/^Left/, "L ")
    .replace(/^Right/, "R ")
    .replace(/Proximal$/, " 1")
    .replace(/Intermediate$/, " 2")
    .replace(/Distal$/, " 3")
    .replace(/UpperArm/, "Upper arm")
    .replace(/LowerArm/, "Forearm")
    .replace(/UpperLeg/, "Thigh")
    .replace(/LowerLeg/, "Shin");
}

export interface ChannelTreeCallbacks {
  /** Selection changed (the set of selected bone names). */
  onChange(selected: Set<string>): void;
}

// ---- selection sets ---------------------------------------------------------
// User-named bone sets, shown as a chip row above the tree's search box. The
// HOST owns the list (it persists next to cleanOps in every rig-state carrier);
// the tree only reads/edits it through this module-level host — same pattern as
// main.ts's rigHotkeys singleton, so curves.ts needs no plumbing changes.

export interface SelectionSet {
  name: string;
  bones: string[];
}

export interface SelectionSetsHost {
  get(): SelectionSet[];
  /** The chip row saved/renamed/deleted a set — persist the new list. */
  onChange(sets: SelectionSet[]): void;
}

let setsHost: SelectionSetsHost | null = null;
let activeTree: ChannelTree | null = null;

/** Install (or clear) the per-recording selection-set store. */
export function setSelectionSetsHost(host: SelectionSetsHost | null): void {
  setsHost = host;
  activeTree?.refreshSets();
}

/** Re-render the chip row after the host's list changed (undo, scene load). */
export function refreshSelectionSets(): void {
  activeTree?.refreshSets();
}

/** Recall a set from outside the tree (View menu) — same onChange path. */
export function recallSelectionSet(bones: string[], additive = false): void {
  activeTree?.applySet(bones, additive);
}

/**
 * A compact, scrollable tree of body-part groups down to individual finger
 * bones. Rows are multi-selectable (ctrl toggles, shift is treated as ctrl for
 * simplicity); clicking a group header selects every bone under it. A search
 * box filters rows by name.
 */
export class ChannelTree {
  readonly el: HTMLDivElement;
  private groups: ChannelGroup[] = [];
  private selected = new Set<string>();
  private cbs: ChannelTreeCallbacks | null = null;
  private filter = "";
  private listEl: HTMLDivElement;
  private setsEl: HTMLDivElement;
  private setPopClose: (() => void) | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "cv-tree";
    this.setsEl = document.createElement("div");
    this.setsEl.className = "cv-sets";
    const search = document.createElement("input");
    search.className = "cv-search";
    search.type = "text";
    search.placeholder = "Search bones…";
    search.spellcheck = false;
    search.addEventListener("input", () => { this.filter = search.value.trim().toLowerCase(); this.render(); });
    this.listEl = document.createElement("div");
    this.listEl.className = "cv-tree-list";
    this.el.append(this.setsEl, search, this.listEl);
  }

  setGroups(groups: ChannelGroup[], cbs: ChannelTreeCallbacks) {
    this.groups = groups;
    this.cbs = cbs;
    activeTree = this;
    this.render();
  }

  getSelected(): Set<string> {
    return new Set(this.selected);
  }

  /** Replace the selection (e.g. viewport effector sync) without a callback. */
  setSelected(bones: Iterable<string>) {
    this.selected = new Set(bones);
    this.render();
  }

  private emit() {
    this.cbs?.onChange(new Set(this.selected));
  }

  private toggleBone(bone: string, additive: boolean) {
    if (!additive) this.selected.clear();
    if (this.selected.has(bone) && additive) this.selected.delete(bone);
    else this.selected.add(bone);
    this.render();
    this.emit();
  }

  private selectBones(bones: string[], additive: boolean) {
    if (!additive) this.selected.clear();
    const allOn = bones.length > 0 && bones.every((b) => this.selected.has(b));
    for (const b of bones) {
      if (allOn && additive) this.selected.delete(b);
      else this.selected.add(b);
    }
    this.render();
    this.emit();
  }

  /** Recall a set: replace the selection, or add to it. Emits onChange. */
  applySet(bones: string[], additive: boolean) {
    if (!additive) this.selected.clear();
    for (const b of bones) this.selected.add(b);
    this.render();
    this.emit();
  }

  /** Re-render the selection-set chips (host list changed). */
  refreshSets() {
    this.renderSets();
  }

  private commitSets(sets: SelectionSet[]) {
    setsHost?.onChange(sets);
    this.renderSets();
  }

  /** Small rename/delete popover on a chip — closes on any outside press. */
  private openSetMenu(x: number, y: number, set: SelectionSet) {
    this.setPopClose?.();
    const pop = document.createElement("div");
    pop.className = "ctx-menu cv-set-pop";
    const item = (label: string, action: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => { this.setPopClose?.(); action(); });
      pop.appendChild(b);
    };
    item("Rename…", () => {
      const name = prompt("Rename selection set:", set.name)?.trim();
      if (!name || name === set.name) return;
      const sets = (setsHost?.get() ?? [])
        .filter((s) => s.name !== name) // renaming onto an existing name replaces it
        .map((s) => (s.name === set.name ? { name, bones: [...s.bones] } : s));
      this.commitSets(sets);
    });
    item("Delete", () => {
      this.commitSets((setsHost?.get() ?? []).filter((s) => s.name !== set.name));
    });
    document.body.appendChild(pop);
    pop.style.left = `${Math.min(x, window.innerWidth - 150)}px`;
    pop.style.top = `${Math.min(y, window.innerHeight - 80)}px`;
    const onDown = (e: PointerEvent) => { if (!pop.contains(e.target as Node)) this.setPopClose?.(); };
    window.addEventListener("pointerdown", onDown);
    this.setPopClose = () => {
      window.removeEventListener("pointerdown", onDown);
      pop.remove();
      this.setPopClose = null;
    };
  }

  private renderSets() {
    this.setsEl.innerHTML = "";
    if (!setsHost) { this.setsEl.hidden = true; return; }
    this.setsEl.hidden = false;
    const sets = setsHost.get();
    const save = document.createElement("button");
    save.className = "cv-set-chip cv-set-save";
    save.textContent = "+ Save";
    save.title = "Save the current bone selection as a named set";
    save.disabled = this.selected.size === 0;
    save.addEventListener("click", () => {
      const name = prompt("Selection set name:", `Set ${sets.length + 1}`)?.trim();
      if (!name) return;
      const bones = [...this.selected];
      const next = sets.some((s) => s.name === name)
        ? sets.map((s) => (s.name === name ? { name, bones } : s))
        : [...sets, { name, bones }];
      this.commitSets(next);
    });
    this.setsEl.appendChild(save);
    for (const set of sets) {
      const chip = document.createElement("button");
      chip.className = "cv-set-chip";
      chip.textContent = set.name;
      const allOn = set.bones.length > 0 && set.bones.every((b) => this.selected.has(b));
      chip.classList.toggle("sel", allOn);
      chip.title = `Recall "${set.name}" (${set.bones.length} bones). Shift-click adds to the selection; right-click to rename/delete.`;
      chip.addEventListener("click", (e) => this.applySet(set.bones, e.shiftKey));
      chip.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.openSetMenu(e.clientX, e.clientY, set);
      });
      this.setsEl.appendChild(chip);
    }
  }

  private matches(name: string): boolean {
    return !this.filter || name.toLowerCase().includes(this.filter) || boneLabel(name).toLowerCase().includes(this.filter);
  }

  private render() {
    this.renderSets();
    this.listEl.innerHTML = "";
    for (const g of this.groups) this.renderGroup(g, 0);
  }

  private renderGroup(g: ChannelGroup, depth: number) {
    const all = groupBones(g);
    const visibleBones = g.bones.filter((b) => this.matches(b) || this.matches(g.label));
    const visibleChildren = (g.children ?? []).filter((c) => groupBones(c).some((b) => this.matches(b) || this.matches(c.label)) || this.matches(g.label));
    if (!visibleBones.length && !visibleChildren.length && !this.matches(g.label)) return;

    const header = document.createElement("div");
    header.className = "cv-group";
    header.style.paddingLeft = `${depth * 12 + 4}px`;
    const on = all.length > 0 && all.every((b) => this.selected.has(b));
    if (on) header.classList.add("sel");
    header.textContent = g.label;
    header.title = "Click to select this group; ctrl-click to add/remove it";
    header.addEventListener("click", (e) => this.selectBones(all, e.ctrlKey || e.metaKey || e.shiftKey));
    this.listEl.appendChild(header);

    for (const b of (this.filter ? g.bones.filter((x) => this.matches(x)) : g.bones)) {
      const row = document.createElement("div");
      row.className = "cv-row";
      row.style.paddingLeft = `${depth * 12 + 16}px`;
      if (this.selected.has(b)) row.classList.add("sel");
      const eye = document.createElement("button");
      eye.className = "cv-eye";
      eye.textContent = this.selected.has(b) ? "●" : "○";
      eye.title = "Show/hide this bone's curves";
      eye.addEventListener("click", (e) => { e.stopPropagation(); this.toggleBone(b, true); });
      const label = document.createElement("span");
      label.textContent = boneLabel(b);
      row.append(eye, label);
      row.addEventListener("click", (e) => this.toggleBone(b, e.ctrlKey || e.metaKey || e.shiftKey));
      this.listEl.appendChild(row);
    }
    for (const c of visibleChildren) this.renderGroup(c, depth + 1);
  }
}
