// OATS Desktop — electron-builder configuration (v0.18.2 public matrix).
//
// Contract (desktop-dist): macOS arm64/x64 DMG+ZIP, Linux x64 AppImage+DEB,
// artifacts named oats-desktop-* under packages/desktop/dist/ (the release
// workflow uploads `desktop-<os>-<arch>` from that glob). macOS bundles are
// AD-HOC SIGNED (identity "-"), NOT Developer ID signed and NOT notarized —
// no Apple credentials exist; certificate auto-discovery stays disabled
// (CSC_IDENTITY_AUTO_DISCOVERY=false in CI) so no keychain identity can
// leak in. Ad-hoc signing is deterministic and local to the artifact: no
// secrets, no network. Linux declares tmux as a package dependency (DEB)
// and documents it for AppImage.
//
// A JS config (not JSON) so the file can carry these binding comments and
// compute nothing — keep it static and reviewable.
module.exports = {
  appId: "ai.oats.desktop",
  productName: "OATS Desktop",
  // artifactName pins the seam: dist/oats-desktop-<version>-<os>-<arch>.<ext>
  // — the workflow globs dist/oats-desktop-* and must never catch stray
  // builder metadata; every artifact below inherits this name.
  artifactName: "oats-desktop-${version}-${os}-${arch}.${ext}",
  directories: { output: "dist" },
  // Ship exactly the app: sources + production deps. The test tree, harness,
  // and builder config itself stay out of the package (inventory-tested).
  files: [
    "main.mjs",
    "preload.cjs",
    "api-url.mjs",
    "app-menu.mjs",
    "single-instance.mjs",
    "window-activity.mjs",
    "window-set.mjs", "window-records.mjs",
    "forge-cli.mjs", "forge-auth.mjs", "forge-auth-output.mjs", "forge-proxy.mjs",
    "instance-events-cli.mjs", "instance-events-proxy.mjs",
    "readiness-cli.mjs", "readiness-proxy.mjs",
    "spawn-preview-proxy.mjs",
    "spawn-apply-proxy.mjs",
    "server-compat.mjs",
    "server-host.mjs",
    "backend-client.mjs",
    "backend-socket.mjs",
    "retired-settings.mjs",
    "tmux-target.mjs",
    "local-tmux-io.mjs",
    "remote-target.mjs",
    "terminal-registry.mjs",
    "terminal-attachments.mjs",
    "terminal-owner.mjs", "terminal-target.mjs", "terminal-io.mjs", "terminal-bridge.cjs",
    "workspace-registry.mjs",
    "picker-default-path.mjs",
    "login-path.mjs",
    "host-theme.mjs",
    "chord-family.mjs",
    "session-resume-launch.mjs",
    "server/**/*",
    "renderer/**/*",
    // Only the sidebar mark ships as a file; the platform icons are wired
    // below and the 1254px source artwork stays out of the package.
    "assets/brand/generated/sidebar-48.png",
    "package.json",
    "!renderer/harness.html",
    "!renderer/harness-server.mjs",
    "!test/**",
    "!build-vendor.mjs",
    "!build-icons.mjs",
    "!build-lucide-icons.mjs",
    "!electron-builder.config.cjs",
    "!**/*.test.mjs",
    "!**/.DS_Store",
  ],
  // The shared home (packages/client: the kernel readers the Desktop shares with other clients)
  // is placed BESIDE app.asar, as <resources>/client. From inside the asar `../client/` is then
  // the same relative path as from this directory in the repository, so shipped modules import
  // it by one plain relative specifier and no copy or install step exists. It is outside the
  // asar: README.md ("The shared home") says what that costs. `from`, `to` and the filter are
  // pinned by test/inventory.test.mjs: change none alone.
  extraResources: [{ from: "../client", to: "client", filter: ["**/*.mjs"] }],
  // node-pty is a native dep: electron-builder runs its own beforeBuild
  // rebuild against the bundled Electron ABI (npmRebuild default true);
  // asarUnpack keeps the prebuilt spawn-helper executable on disk where
  // posix_spawnp can exec it (inside asar it cannot).
  asarUnpack: ["**/node_modules/node-pty/**"],
  npmRebuild: true,
  // Fresh `npm ci` can deliver node-pty's prebuilt spawn-helper WITHOUT the
  // execute bit (posix_spawnp then fails in the packaged app — release
  // blocker found by the integration gate). Restore it deterministically on
  // the PACKED output; never rely on working-tree chmod residue. afterPack
  // runs BEFORE electron-builder's signing step, so the chmod lands inside
  // the sealed resources — mutating the bundle after signing would break
  // the strict deep verification gate.
  afterPack: "scripts/after-pack.cjs",
  mac: {
    // Targets WITHOUT pinned arch: electron-builder builds the HOST arch by
    // default, so each CI matrix job (macos-15=arm64, cross-built x64) produces
    // exactly its own pair and the desktop-<os>-<arch> artifact stays pure.
    // Cross-arch fallback (if the x64 runner disappears):
    //   npm run dist -- --x64   on an arm64 runner.
    target: ["dmg", "zip"],
    category: "public.app-category.developer-tools",
    // AD-HOC SIGNED: identity "-" makes electron-builder/@electron/osx-sign
    // produce a COMPLETE ad-hoc bundle signature — every nested Electron
    // helper/framework signed and resources sealed — so
    //   codesign --verify --deep --strict --verbose=2 "OATS Desktop.app"
    // exits zero (verified for arm64 and the x64 cross-build; gated by
    // dist:smoke). The former identity:null DISABLED signing entirely,
    // which shipped the v0.18.2 defect: the arm64 executable kept only its
    // linker-generated partial ad-hoc signature (no _CodeSignature seal →
    // strict verify fails → Gatekeeper "damaged"), x64 was unsigned.
    // Ad-hoc is NOT Developer ID and NOT notarization: no identity, no
    // secrets, deterministic; Gatekeeper still requires the user's explicit
    // first-launch approval. Nothing may claim identified-developer trust.
    identity: "-",
    // Derived from assets/brand/oats-logo.png by `npm run icons`.
    icon: "assets/brand/generated/oats.icns",
  },
  linux: {
    // Filesystem-safe binary/package name. WITHOUT this, electron-builder
    // derives executableName from the SCOPED package name
    // "@awebai/oats-desktop" → "@awebaioats-desktop", which contains
    // "@"/"/" and FAILS the AppImage/DEB build ('characters that cannot be
    // safely used in file paths') — the v0.18.x Linux leg never went green
    // without it. Scoped to linux so the mac .app stays "OATS Desktop.app".
    executableName: "oats-desktop",
    // NxN.png set derived from assets/brand/oats-logo.png by `npm run icons`.
    icon: "assets/brand/generated/linux",
    target: ["AppImage", "deb"],
    category: "Development",
    // tmux is a hard runtime prerequisite (terminal attach path).
    // DEB declares it; AppImage cannot declare deps — docs carry it.
    synopsis: "Control panel for OATS agent deployments",
    description: "OATS Desktop — roster, brain and terminal access for OATS agent deployments. Requires tmux and an installed @awebai/oats CLI for lifecycle actions.",
  },
  deb: {
    depends: ["tmux"],
    // electron-builder requires a DEB maintainer + project homepage; without
    // them the deb target fails AFTER the AppImage builds (surfaced by the
    // build-installers CI). homepage is read from packages/desktop
    // package.json; the maintainer is set explicitly here.
    maintainer: "OATS Framework <maintainers@oats-framework.dev>",
  },
  dmg: {
    // default layout; no code that would require signing
    writeUpdateInfo: false,
  },
  // No publish config: CI uploads artifacts itself; electron-builder must
  // never attempt a GitHub publish from a build job.
  publish: null,
};
