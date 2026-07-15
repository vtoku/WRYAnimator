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

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "cv-tree";
    const search = document.createElement("input");
    search.className = "cv-search";
    search.type = "text";
    search.placeholder = "Search bones…";
    search.spellcheck = false;
    search.addEventListener("input", () => { this.filter = search.value.trim().toLowerCase(); this.render(); });
    this.listEl = document.createElement("div");
    this.listEl.className = "cv-tree-list";
    this.el.append(search, this.listEl);
  }

  setGroups(groups: ChannelGroup[], cbs: ChannelTreeCallbacks) {
    this.groups = groups;
    this.cbs = cbs;
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

  private matches(name: string): boolean {
    return !this.filter || name.toLowerCase().includes(this.filter) || boneLabel(name).toLowerCase().includes(this.filter);
  }

  private render() {
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
