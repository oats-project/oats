// App icons are Lucide (the Redesign v3 glyphs are "placeholders for Lucide"),
// vendored as generated data in lucide-icons.mjs. Only names in ICONS are
// accepted: no paths, attributes, URLs or SVG ever come from data.
import { LUCIDE_ICONS } from "./lucide-icons.mjs";

/** App icon name → Lucide icon. The shell's semantic names stay stable. */
export const ICONS = Object.freeze({
  overview: "circle-dot", workspace: "house", schedules: "clock", plus: "plus", sidebar: "panel-left", panel: "panel-right",
  theme: "contrast", font: "type", shortcuts: "keyboard", palette: "terminal", settings: "sliders-horizontal", cog: "settings",
  chevron: "chevron-down", chevronDown: "chevron-down", chevronRight: "chevron-right", chevronLeft: "chevron-left",
  splitRight: "columns-2", splitDown: "rows-2",
  search: "search", more: "ellipsis", close: "x", check: "check", refresh: "refresh-cw", reset: "rotate-ccw",
  warning: "triangle-alert", alert: "circle-alert", info: "info", branch: "git-branch", repo: "folder-git-2", package: "package", computer: "laptop", soul: "sparkles",
  zoomIn: "plus", zoomOut: "minus", fit: "maximize-2", start: "play", stop: "square", remove: "trash-2",
  newWindow: "app-window", external: "external-link", pullRequest: "git-pull-request", knowledge: "book-open", file: "file-text",
  brain: "brain", terminal: "square-terminal", mail: "mail", tasks: "list-checks", home: "house",
  triggers: "zap", test: "flask-conical", automations: "workflow", users: "users",
  // v4.1 instance panel: work-mode tiles (folder, link, layers; git-branch is `branch`), the Folder row's Copy, the eligible-team circle.
  folder: "folder", link: "link", layers: "layers", copy: "copy", circle: "circle",
  // Setup's "For developers" drawing: the host lists a member, the member names the workspace back.
  arrowRight: "arrow-right", arrowLeft: "arrow-left",
  // Pinned instances: a pinned row's mark on its name line, and the row menu's Pin to top / Unpin.
  pin: "pin", unpin: "pin-off",
});
/** Marks drawn here, not Lucide's, on the same 24-unit grid. `attention`, the needs-input mark (2026-10-23): a full
 * disc with a rounded bar and a separate dot, the "!" of Lucide's circle-alert made bold enough to read as one at
 * 12–14px (its 2-unit strokes leave half a pixel between bar and dot there). Colours are shell.css's (.attn-mark). */
export const OWN_ICONS = Object.freeze({
  attention: [["circle", [["class", "attn-disc"], ["cx", "12"], ["cy", "12"], ["r", "12"]]],
    ["rect", [["class", "attn-glyph"], ["x", "10.3"], ["y", "5"], ["width", "3.4"], ["height", "9.4"], ["rx", "1.7"]]],
    ["circle", [["class", "attn-glyph"], ["cx", "12"], ["cy", "18.4"], ["r", "2"]]]],
});
const ATTR = /^[-0-9a-zA-Z .,]*$/;
function iconNodes(name) {
  if (Object.hasOwn(OWN_ICONS, name)) return OWN_ICONS[name];
  if (!Object.hasOwn(ICONS, name)) throw new TypeError("Unknown shell icon");
  return LUCIDE_ICONS[ICONS[name]];
}
/** SVG markup for a named app icon (16px default, Lucide 24-unit grid). */
export function icon(name, { size = 16, className = "shell-icon" } = {}) {
  const inner = iconNodes(name).map(([tag, attrs]) => `<${tag} ${attrs.filter(([, v]) => ATTR.test(v)).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`).join("");
  const px = Number.isInteger(size) && size > 0 && size <= 64 ? size : 16;
  return `<svg class="${className}" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
}
/** The same icon as DOM nodes (no HTML parsing), for views that build with createElement. */
export function iconElement(document, name, { size = 16, className = "shell-icon" } = {}) {
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
  const px = String(Number.isInteger(size) && size > 0 && size <= 64 ? size : 16);
  for (const [k, v] of [["class", className], ["width", px], ["height", px], ["viewBox", "0 0 24 24"], ["fill", "none"], ["stroke", "currentColor"],
    ["stroke-width", "2"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"], ["focusable", "false"]]) svg.setAttribute(k, v);
  for (const [tag, attrs] of iconNodes(name)) {
    const child = document.createElementNS(NS, tag);
    for (const [k, v] of attrs) if (ATTR.test(v)) child.setAttribute(k, v);
    svg.append(child);
  }
  return svg;
}

export function shellIcon(name) {
  // The brand is artwork (assets/brand), not a shell icon.
  return icon(name);
}

/** Fill only shell-owned, explicitly named icon slots. Names never come from APIs. */
export function mountShellIcons(document) {
  for (const slot of document.querySelectorAll("[data-shell-icon]")) {
    slot.innerHTML = shellIcon(slot.dataset.shellIcon);
  }
}
