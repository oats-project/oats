# Desktop file viewer

The Desktop shows workspace files (Markdown, and plain text with syntax highlighting) **read-only**,
in an ordinary tab. It is a viewer, not an editor: there is no save, rename, format or execute. No
CLI command asks the Desktop to open a file.

## Reading a file: `GET /api/file?path=<absolute>`

`server/oats-web.mjs` (`fileData`, `resolveGuardedFile`, `fileRoots`). The server-wide
[control admission](../../../docs/desktop.md#security-posture) requires the launch token and
checks any supplied Origin. The file guards below further restrict authorized reads.

**Allowed roots** (`fileRoots`), canonicalized with `realpath` once, when the request is admitted:
- every root of every known workspace;
- every soul directory the kernel reported for an observed local deployment, only when its
  canonical path stays inside the canonical deployment (a symlinked soul directory never widens
  the roots);
- every known local instance's home, when its canonical path stays inside its deployment, plus
  that home's `work` tree and the instance's repo (operator checkouts that may live elsewhere).

A remote (server-routed) instance grants no local roots.

**The guard** (`resolveGuardedFile`):
- the path must be absolute, or the answer is 400;
- only the **requested** path is resolved at use (`realpath`, symlinks followed). A missing file
  is 404;
- it must equal an allowed root, or sit under one by root-plus-separator containment
  (`/root-evil` is not under `/root`), or the answer is 403;
- **the roots are never re-resolved at use.** Re-resolving them would reopen the
  admission-to-use race: a directory swapped for a symlink between admission and the check.

**The read** (`fileData`):
- a non-regular file is 400;
- larger than 2 MiB is 413;
- containing a NUL byte ("binary") is 415.

The answer is `{path (canonical), name, size, mtime, markdown, content}`. `markdown` is true for
`.md`, `.markdown`, `.mdown` and `.mkd`.

The route is **not workspace-pinned**: a `ws` query does not narrow the allowed roots.

The guard block is extracted between the `OATSWEB_FILEGUARD` markers and exercised by the repo
root's `test/desktop-server.test.mjs`.

## Rendering: `renderer/views/markdown.mjs`

- **Sources:** a file the operator picked in the chooser (read in the renderer only: basename
  provenance, and no local-link navigation), or `GET /api/file` via `ctx.api`.
- **Markdown** is rendered with `marked`, and code is highlighted with `highlight.js`. Every
  inserted node passes **DOMPurify**, which forbids `style`, `form`, `input` and `button`.
  - For a picked file, anything that would fetch a resource (images, media, frames, embeds, SVG,
    style/src attributes) is removed as well.
  - URIs are limited to `http:`, `https:`, `mailto:` and `#`.
- **Links:** every surviving anchor is normalized.
  - A relative link to another file becomes a local link that re-opens through `ctx.openFile`.
    It's removed for a picked file, which has no path authority.
  - Any other link must use an allowed external scheme, and gets `target="_blank"
    rel="noreferrer noopener"`. A raw-HTML anchor cannot keep its own target or rel.
- **Shared with the capability page.** The pipeline is exported (`renderMarkdownHtml`,
  `renderCodeHtml`, `isMarkdownName`, `decorateMarkdown`, `MARKDOWN_CSS`) and the capability
  page's Contents reader renders through it, never through a copy. A capability's files are
  untrusted repository content, so the reader asks for `strict: true`:
  - raw HTML is shown as escaped text (a block of it as a code block), never passed through;
  - images (any scheme) render as their alt text;
  - the sanitizer uses the picked-file profile (no resource-loading tags or attributes) but keeps
    local links, which the reader opens in place only when they name a file the capability lists
    (`rootedLinks: false`: an absolute path is plain text).
- **The main process** (`main.mjs`) opens only `http(s)` URLs externally (`shell.openExternal`).
  It denies every window-open, and every navigation away from the renderer file, so a page can
  never inherit the preload bridge.
