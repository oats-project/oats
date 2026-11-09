// On a machine found-list (oats-omarchy's installer hands one over), the
// getting-started skill makes the workspace the machine's own: it pins the
// catalog's oats.machine, its setup soul is oats.machine/steward, and the steward
// gets a global, contacts-only aweb address through `oats aweb resident create`'s
// root route, or a local team identity when that route is not there. The skill's
// literals are checked here against the catalog and against the oats.aweb
// provider's own source (mirrors/oats-aweb), so they cannot drift from what the
// provider prints.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const skill = read("skills/oats-getting-started/SKILL.md");
const catalog = JSON.parse(read("package-catalog.json"));
const residentSource = read("mirrors/oats-aweb/lib/resident.mjs");
const providerVersion = JSON.parse(read("mirrors/oats-aweb/oats.json")).version;
const setupInviteSources = () => read("mirrors/oats-aweb/lib/setup-invite.mjs") + read("mirrors/oats-aweb/bin/oats-aweb.mjs");
const atLeast = (v, min) => {
  const a = v.split(".").map(Number), b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

// The root route ships in no oats.aweb release yet (awebai/oats-aweb#147 is not
// merged; 1.33.x to 1.37.0 lack it), so the skill names no provider version and
// always takes the fallback. The release prep that pins #147's release sets
// that version once. Its aw floor is 1.36.48 (oats.aweb's AW_RESIDENT_ROOT_MIN).
const NO_ROOT_ROUTE_YET = "None is released yet: until one is, take the fallback below";
const AW_ROOT_ROUTE = "1.36.48";
const mirrorHasRootRoute = residentSource.includes('route: "root"');

test("the catalog lists oats.machine at v0.1.1, and oats.machine-care resolves to it", () => {
  assert.deepEqual(catalog.packages["oats.machine"], { url: "https://github.com/awebai/oats-machine.git", ref: "v0.1.1", path: "oats-package" });
  assert.equal(catalog.capabilities["oats.machine-care"], "oats.machine");
  assert.match(read("docs/official-catalog.md"), /^\| `oats\.machine` \| `v0\.1\.1` \| `oats\.machine-care` \| `steward`, `technician` \|$/m);
});

test("on a machine found-list the workspace pins the catalog's oats.machine by bare version", () => {
  assert.match(skill, /^  oats\.machine: v0\.1\.1\b/m);
  assert.equal(`v${skill.match(/^  oats\.machine: v(\S+)/m)[1]}`, catalog.packages["oats.machine"].ref);
  assert.doesNotMatch(skill, /git:github\.com\/awebai\/oats-machine/, "an official package is pinned by bare version, never by Git");
  assert.match(skill, /`machine\.platform`/, "the step applies only to a machine found-list");
});

test("the steward's resident is planned, checked for the root route, then created, with no API key", () => {
  const plan = "env -u AWEB_API_KEY oats aweb resident create R --team-label L --plan --json";
  const run = "env -u AWEB_API_KEY oats aweb resident create R --team-label L --json";
  assert.ok(skill.includes(`cd "D" && ${plan}\n`), "the plan line");
  assert.ok(skill.includes(`cd "D" && ${run}\n`), "the run line: the plan's argv without --plan");
  assert.ok(skill.includes("`result.init.route` is `root`"), "the plan's route is checked");
  assert.ok(skill.includes("`result.init` is `null`"), "an existing resident is adopted, never created twice");
  // The flags exist in the provider's parser.
  for (const flag of ["--team-label", "--plan", "--json"]) assert.ok(residentSource.includes(`"${flag}"`), `oats aweb resident create takes ${flag}`);
});

test("the steward is spawned with the provider's printed grant-seat options", () => {
  const spawn = residentSource.match(/const SPAWN = \(name\) => `oats spawn <soul> (.*?)\$\{name\}`;/);
  assert.ok(spawn, "the provider prints the seat's spawn line");
  const options = `${spawn[1]}R`;
  assert.equal(options, "--provider oats.aweb identity.mode=global --provider oats.aweb identity.resident=R");
  for (const verb of ["--preview", ""]) {
    assert.ok(skill.includes(`oats spawn S --dir D --task-file D/.oats-handover.md --name R ${options}${verb ? ` ${verb}` : ""}\n`), `the global spawn${verb ? " preview" : ""}`);
  }
});

test("the fallback names the floors, and says it in one line, with no question and no key", () => {
  assert.match(skill, /Tell the person in one line,\s+without asking anything/);
  assert.ok(skill.includes("Never ask for a key."));
  assert.ok(skill.includes(`aw ${AW_ROOT_ROUTE} or later`));
  assert.match(skill, /GLOBAL residents and grant\s+seats section of `\/oats-aweb`/, "the line names /oats-aweb's section that moves it later");
  // While the mirror lacks the root route, the skill always takes the fallback; once
  // it carries it (#147 released and pinned), the skill must name that release
  // instead, and the route's aw floor must be the skill's.
  const skillText = skill.replace(/\s+/g, " ");
  if (!mirrorHasRootRoute) {
    assert.ok(skillText.includes(NO_ROOT_ROUTE_YET), `oats.aweb ${providerVersion} has no root route: the skill must always take the fallback`);
  } else {
    assert.ok(!skillText.includes(NO_ROOT_ROUTE_YET), `oats.aweb ${providerVersion} carries the root route: name its release in the skill`);
    assert.match(read("mirrors/oats-aweb/lib/aw-floor.mjs"), new RegExp(`AW_RESIDENT_ROOT_MIN = '${AW_ROOT_ROUTE.replaceAll(".", "\\.")}'`));
  }
});

test("on a machine found-list, step 1 is the machine's round, with a default for every value", () => {
  assert.ok(skill.includes("On a machine found-list, ask the machine's round below instead of this list."));
  const round = skill.slice(skill.indexOf("**The machine's round.**"), skill.indexOf("## 2. Check"));
  assert.ok(round.includes("Enter, or\n\"yes\", accepts every default. Nothing is asked after this round, and never\na key."));
  assert.ok(round.includes("lowercased, with every character outside `[a-z0-9-]` turned\n  into `-`"), "the workspace and N default to the normalised hostname");
  // N follows the hostname, never the workspace's name, which the person may change.
  assert.match(round, /\*\*The namespace `N`:\*\*[^-]*Default:\s+the hostname, normalised as above/);
  // R is the chosen name, prefixed by the hostname in another machine's namespace, whatever name was chosen.
  assert.match(round, /`R` is the chosen name,\s+or `<hostname>-<chosen name>`/);
  for (const value of ["**The workspace:**", "`<workspace>-root`", "**The steward's name:**", "Default: `steward`", "**The deployment directory `D`:** default `<home>/Agents/<workspace>`", "**OATS Desktop:** installed and started by default", "**The harness:** the found-list's `harness`"]) {
    assert.ok(round.includes(value), `the machine's round gives ${value}`);
  }
});

test("after step 1, a machine found-list asks nothing: a step that would ask tells and stops", () => {
  assert.match(skill, /Wherever a later step says to ask the\s+person, on a machine found-list you tell them what happened, as it is, and\s+stop instead/);
  assert.match(skill, /On a machine found-list, ask nothing: tell the person that the run\s+failed, most likely because `N` is taken, and stop\./);
});

test("the steward's harness is recorded before readiness and harness trust read it", () => {
  // '*' is every soul without its own entry, S and the souls spawned later included (#1665, further runs).
  const set = "oats soul launch set '*' --harness <harness> --dir D";
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes("So read `oats souls --dir D --json` first, in a new workspace too (a package soul may name its harness). For each row whose `launch.declared.harness` differs from `<harness>` and whose declared harness is installed and logged in here"), "a soul's declared harness keeps its own entry in every workspace, when it can run here");
  // A declared harness this machine lacks would leave the soul unable to run: it stays under '*' (#1726 review).
  assert.ok(flat.includes("A declared harness that isn't installed here stays under `'*'`, so the soul can run; name it in the hand-over"));
  const plan = skill.indexOf(`${set} --plan\n`), apply = skill.indexOf(`${set}\n`);
  assert.ok(plan > 0 && apply > plan, "planned, then applied");
  // A soul whose declared harness differs: its own entry, by the row's unambiguous key, with its model, plan first.
  const perSoul = "oats soul launch set <key> --harness <its harness> --model <its model> --dir D";
  const soulPlan = skill.indexOf(`${perSoul} --plan\n`), soulApply = skill.indexOf(`${perSoul}\n`);
  assert.ok(soulPlan > apply && soulApply > soulPlan, "the per-soul entry is planned, then applied, after '*'");
  assert.ok(flat.includes("Use the row's `key` (`<package>/<soul>` for a package's soul, so the name is never ambiguous), add `--model <its model>` only when `launch.declared.model` names one"));
  // S keeps the person's choice: its own entry only when it declares another harness, and only with <harness>.
  assert.ok(flat.includes("`S` is the exception: it always keeps `<harness>`, the person's choice in step 1. When `S` declares another harness, give it its own entry with `<harness>` instead"));
  const sSet = "oats soul launch set S --harness <harness> --dir D";
  const sPlan = skill.indexOf(`${sSet} --plan\n`), sApply = skill.indexOf(`${sSet}\n`);
  assert.ok(sPlan > soulApply && sApply > sPlan, "S's exception is planned, then applied, after the per-soul entries");
  assert.equal(skill.split("oats soul launch set S ").length, 3, "S alone appears only in its exception (plan and apply)");
  assert.ok(sApply < skill.indexOf("oats harness trust --dir D"), "S's entry before harness trust");
  assert.ok(apply < skill.indexOf("oats harness trust --dir D"), "before harness trust");
  assert.ok(apply < skill.indexOf("oats readiness --soul S --dir D --json"), "before readiness");
  assert.ok(apply < skill.indexOf("oats spawn S --dir D --task-file D/.oats-handover.md --name R"), "before the spawn, which then takes no --harness");
});

test("a root that is not a member of the team stops step 9 before the spawn, with its fix", () => {
  // The fields the stop reads are the ones `oats aweb setup --check-only` prints.
  const provider = read("mirrors/oats-aweb/bin/oats-aweb.mjs");
  assert.match(provider, /console\.log\(JSON\.stringify\(\{ aw, defaultTeam: label \|\| team \? \{ label, team \} : null, member, root: teamRoot \}\)\)/);
  const stop = skill.indexOf("**`\"member\": false` after step 5's sign-in:** stop, spawn nothing");
  assert.ok(stop > skill.indexOf("## 9. Messaging on this machine") && stop < skill.indexOf("## 10. Spawn the setup expert"), "in step 9, before the spawn");
  const fix = skill.slice(stop, skill.indexOf("\n2. ", stop));
  assert.match(fix, /With\s+`"root": null`, there is no root in `D\/\.aw`: step 5's team creation did\s+not finish there, so run its line for an interrupted run, then check\s+again\./);
  assert.match(fix, /the team id step 7 wrote must be step 5's `canonical_team_id` exactly/);
  assert.match(skill, /expect `"member": true`\.\n\s+On `"member": false`, stop and spawn nothing/);
  // Without step 5's sign-in there is no root yet: the first check is not a member and goes on to the signup.
  assert.match(skill, /Every other new workspace \(the default, and a machine found-list\)\s+has no root yet, so its `"member": false` here is expected: go on to\s+item 2\./);
  assert.ok(stop < skill.indexOf("2. **A new workspace without step 5's sign-in, and a machine found-list:"), "the first check reaches the signup");
});

test("the default new workspace signs up without a sign-in, and the team id it writes is checked against setup's answer", () => {
  const signup = read("mirrors/oats-aweb/lib/setup-team-default.mjs");
  // The skeleton's team is the provider's own predicted team, and the answer carries team and membershipVerified.
  assert.ok(signup.includes("predictedTeam = `default:${username}.aweb.ai`"));
  assert.ok(signup.includes("return { plan: false, label, team, root, steps, observed, membershipVerified: true };"));
  assert.match(skill, /the messaging account's name `N`[^]*?default\s+`<workspace>-oats`/);
  assert.match(skill, /## 5\. Optional: the team on your own aweb account/);
  assert.match(skill, /- \*\*The team\*\* is `default:N\.aweb\.ai`, with `N` from step 1/);
  const item2 = skill.slice(skill.indexOf("2. **A new workspace without step 5's sign-in, and a machine found-list:"), skill.indexOf("\n3. **Existing workspace"));
  assert.ok(item2.includes("cd \"D\" && oats aweb setup --soul S --username N --name A --label L --plan --json"));
  assert.match(item2, /`result\.team` must be\s+the team line step 7 wrote, `default:N\.aweb\.ai`, and\s+`result\.membershipVerified` must be `true`/);
  const flat = item2.replace(/\s+/g, " ");
  assert.ok(flat.includes("Ask the person for another `N`, change the team line in `D/<repo>/oats-workspace.yaml` to `default:<new N>.aweb.ai`, commit and push it, run `oats sync --dir D`, then run the preview and the signup again"));
  // A changed N only when the failed run kept no root; a retained root keeps N and the team line.
  assert.ok(flat.indexOf("test -e \"D/.aw\" && echo RETAINED") < flat.indexOf("Ask the person for another `N`"), "the rename is gated on no retained root");
  assert.ok(flat.includes("**Nothing printed:** aw kept nothing, so `N` is free to change."));
  assert.ok(flat.includes("**`RETAINED`:** the run left a root. Keep `N` and the team line, and run the preview again, unchanged."));
  assert.ok(flat.includes("this is the workspace's team, on an aweb account created for it; they attach themselves to it later in the setup, with the setup expert"));
  assert.ok(!flat.includes("setup expert's first steps"), "attaching comes later in the setup, not first (#1665 campaign, ux2)");
});

test("only the sign-in route says the team is owned by the person's account", () => {
  const step5 = [skill.indexOf("## 5. "), skill.indexOf("## 6. ")];
  for (let i = skill.indexOf("owned by"); i !== -1; i = skill.indexOf("owned by", i + 1)) {
    const inStep5 = i > step5[0] && i < step5[1];
    const tagged = /signed in at step 5/.test(skill.slice(i - 120, i + 120));
    assert.ok(inStep5 || tagged, `"owned by" outside the sign-in route: ${skill.slice(i - 60, i + 60)}`);
  }
  assert.ok(!/owned by your account/.test(read("README.md")), "the README's default path says nothing about ownership");
});

// The onboarding VM campaign's newcomer runs (#1665): what the person is asked to do, and what changes on their computer.
test("getting-started: one yes covers the computer's changes; a refused step is never run another way", () => {
  const flat = read("skills/oats-getting-started/SKILL.md").replace(/\s+/g, " ");
  assert.ok(flat.includes("Never run `sudo` for something that was not on that list, even where no password is asked"));
  // The list comes from step 2's read-only checks, run before step 1's message (#1665 campaign review).
  assert.ok(flat.includes("**First, step 2's checks.** They only read, so run them before the message"));
  assert.ok(flat.includes("**The changes to this computer:** the list in \"How to work\", from step 2's checks"), "the machine's round lists them too");
  // A harness refusal is not routed around: ask once by name, retry once, else say what is missing.
  assert.ok(flat.includes("never run it another way (another shell, a script, a window you open)"));
  assert.ok(flat.includes("Never ask them to type a command with `!`."));
  assert.ok(!flat.includes("run that command in their own terminal, which you open for them"), "a refused step does not move to a window");
  assert.ok(flat.includes("PATH=\"$PATH:/sbin:/usr/sbin\" ldconfig -p"), "the Desktop's libraries are checked where a user's PATH lacks /sbin");
  assert.ok(flat.includes("**FUSE 2 missing:** install nothing."));
  assert.ok(flat.includes("`sudo -n true` is not one of those checks: it runs after the yes"), "no sudo, not even -n, before the yes");
  assert.ok(!/\|\| true`\)/.test(flat), "checks keep their exit status");
  assert.ok(!flat.includes("ask them to restart you"));
  assert.ok(!flat.includes("ask for it, and suggest none"), "the folder where agents live has a default");
  assert.ok(!/Ask for (?:its|their) (?:GitHub )?owner/.test(flat), "the host's owner is derived, not asked");
});

test("getting-started: an existing workspace names its setup expert after this machine, and joins with the invite alone", () => {
  const flat = read("skills/oats-getting-started/SKILL.md").replace(/\s+/g, " ");
  assert.ok(flat.includes("`--name <workspace>-<this machine's name>-oats-setup-expert`"));
  assert.ok(flat.includes("short hostname (`hostname -s`, never the full domain name)"));
  assert.ok(flat.includes("so a rerun derives the same name"), "a long name is shortened deterministically, never left to spawn");
  // The agent can't see the join's output, so a taken name is named at item 5's stop, never rerun around (#1665 re-review N1).
  assert.ok(flat.includes("say that a taken name is a likely cause"));
  assert.ok(!flat.includes("open the window again, with a new invite"), "no rerun of the join after a failure");
  assert.ok(flat.includes("**An existing workspace's name** is its `--name` without the trailing `-oats-setup-expert`"));
  assert.ok(flat.includes("A new workspace keeps `next.spawn` as it is."));
  assert.ok(flat.includes("`I` is its instance name: the `--name` you spawned with"));
  assert.ok(!/Choose with the person a name `A`/.test(flat), "the messaging root's name is derived, not asked");
  // The one-paste join (awebai/oats-aweb#56, oats.aweb 1.36.0, aw 1.36.53): the token alone, no --join, no --service.
  assert.ok(flat.includes("**The token is all they pass** when this machine has oats.aweb 1.36.0 or later"));
  assert.ok(flat.includes("| oats aweb setup --soul S --invite-stdin --name A'"), "the joiner's command takes the token alone");
  // Each refusal the skill names is one the provider makes before redeeming; a service is refused only for an explicit
  // --service, which the invite-only form never passes, so the skill names none.
  assert.ok(flat.includes("Before redeeming anything, it refuses an invite it can't use here"));
  assert.ok(!/refuses an invite[^.]*another service/.test(flat), "no service refusal is promised for the invite-only form");
  const providerSources = setupInviteSources();
  for (const code of ["E_SETUP_INVITE_INSPECT", "E_SETUP_INVITE_SCOPE", "E_SETUP_LABEL_COLLISION", "E_SETUP_ALREADY_MEMBER"])
    assert.ok(providerSources.includes(code), `the provider refuses with ${code}`);
  // A team the workspace doesn't name is refused before redeeming: E_SETUP_POLICY where local teams are closed, and
  // E_SETUP_DEFAULT_PRESERVE where the default comes from the workspace file. Only a machine whose own oats-local.yaml
  // sets the default redeems it and maps that team under a label of its own; item 5 tells the two apart read-only,
  // because a per-team root is made only by a redemption.
  assert.ok(flat.includes("one for a team this workspace doesn't name (unless the workspace allows local teams and this machine's own `oats-local.yaml` sets its default team)"));
  const teamDefault = read("mirrors/oats-aweb/lib/setup-team-default.mjs");
  assert.ok(teamDefault.includes("throw setupFailure('E_SETUP_POLICY', 'local-teams-closed"), "the provider refuses an unnamed team where local teams are closed");
  assert.ok(teamDefault.includes("doc.defaultTeam.from !== 'deployment'") && teamDefault.includes("throw setupFailure('E_SETUP_DEFAULT_PRESERVE'"), "the provider refuses an unnamed team where the default is the workspace's");
  assert.ok(flat.includes("In that exception, an invite for a team the workspace doesn't name is redeemed instead"));
  assert.ok(setupInviteSources().includes('join(resolve(base), ".aweb-roots", normalizeAwebTeamName(label))'), "a redemption makes the per-team root item 5 looks for");
  assert.ok(flat.includes("With `\"root\": null` after item 4's invite-only form, look first, read-only: `ls -d \"D\"/.aweb-roots/*/.aw 2>/dev/null`. Nothing printed: the join refused before redeeming anything"), "a refusal is not read as a root left outside L");
  assert.ok(flat.includes("A path printed for a label other than `L`: the invite was for that team, and this machine joined it instead"), "a redeemed invite for another team is not read as a refusal");
  const setupInvite = read("mirrors/oats-aweb/lib/setup-invite.mjs");
  const awFloor = setupInvite.match(/AW_INVITE_INSPECT = '([0-9.]+)'/);
  assert.ok(awFloor && flat.includes(`aw ${awFloor[1]} or later (\`aw.version\` in item 1's check)`), "the skill's aw floor is the provider's");
  // Older providers keep the labelled form; awebUrl is new in oats.aweb 1.33.1 and may be null: that join works without --service.
  assert.ok(flat.includes("from oats.aweb 1.33.1 the answer's `result.awebUrl`, no secret"));
  assert.ok(flat.includes("When it is `null` or absent, leave `--service U` out of item 4's labelled form"));
  assert.ok(flat.includes("| oats aweb setup --soul S --join L --invite-stdin --name A --service U'"));
  assert.ok(!flat.includes("default service"), "the provider has no default service: the join fails without one");
  const invite = read("mirrors/oats-aweb/lib/invite.mjs");
  const [maj, min, pat] = providerVersion.split(".").map(Number);
  if (maj > 1 || (maj === 1 && (min > 33 || (min === 33 && pat >= 1)))) assert.ok(invite.includes("awebUrl"), "the invite answer carries awebUrl from 1.33.1");
});

test("the Desktop's background download is installed only once its checksum and attestation passed", () => {
  // The release lane's rule (D6, #1665): the download runs in the background, never unverified to the install.
  const start = skill.match(/W="\$\(mktemp -d\)" && echo "\$W" && \{ nohup sh -c '([^']*)' sh "\$W" <\/dev\/null >"\$W\.log" 2>&1 & \}/);
  assert.ok(start, "only the nohup runs in the background, so the command returns at once");
  assert.ok(start[1].includes("gh attestation verify") && start[1].endsWith("&& echo VERIFIED; echo DONE"), "VERIFIED only after the checks; DONE always");
  const installs = skill.match(/grep -qx VERIFIED "<W>\.log" && [^\n]*cd "<W>"/g) || [];
  assert.equal(installs.length, 3, "the Linux install, the macOS check and the macOS install are each gated on VERIFIED");
  assert.ok(skill.includes("never install or open this download before its\nattestation has passed"));
});

test("the download names the new owner, and VERIFIED follows only a passing download, checksum and one pinned attestation", () => {
  // After the move to oats-project, attestations of releases up to 0.69.12 stayed with the awebai
  // organisation; later ones are in oats-project/oats. The awebai form is tried only for those
  // versions, each form is pinned to its own repository's release workflow at the release's tag,
  // and neither stands in for a failed download or checksum.
  const start = skill.match(/\{ nohup sh -c '([^']*)' sh "\$W"/);
  assert.ok(start);
  const bodyFor = (v) => start[1].replaceAll("vV", `v${v}`).replaceAll('"F"', '"f.AppImage"').replaceAll(" F\\$", " f.AppImage\\$");
  const body = bodyFor("0.69.12");
  assert.ok(body.includes('gh release download "v0.69.12" -R oats-project/oats '));
  assert.doesNotMatch(body, /-R awebai\/oats|--repo awebai\/oats/);
  const forms = body.match(/gh attestation verify [^;|&]*/g).map((f) => f.trim());
  assert.deepEqual(forms, [
    'gh attestation verify "f.AppImage" --repo oats-project/oats --signer-workflow oats-project/oats/.github/workflows/release.yml --source-ref refs/tags/v0.69.12',
    'gh attestation verify "f.AppImage" --owner awebai --signer-workflow awebai/oats/.github/workflows/release.yml --source-ref refs/tags/v0.69.12',
  ]);
  // Run the real command line with stand-ins for gh and sha256sum, failing each step in turn. The
  // stand-ins answer only for the expected file, tag and checksum line.
  const dir = mkdtempSync(join(tmpdir(), "oats-verify-"));
  try {
    const bin = join(dir, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$1 $2" in
  "release download") [ "$DL" = ok ] || exit 1; echo "x  \${SUMS_FILE:-f.AppImage}" > SHA256SUMS.txt; : > f.AppImage;;
  "attestation verify")
    case "$*" in *"f.AppImage"*"--source-ref refs/tags/$TAG") ;; *) exit 9;; esac
    case "$*" in *"--repo oats-project/oats --signer-workflow oats-project/oats/"*) [ "$NEW" = ok ];; *"--owner awebai --signer-workflow awebai/oats/"*) [ "$OLD" = ok ];; *) exit 9;; esac;;
  *) exit 9;;
esac
`, { mode: 0o755 });
    // Like macOS's sha256sum, it passes empty input; only the expected line and SUM=ok pass otherwise.
    writeFileSync(join(bin, "sha256sum"), `#!/bin/sh\nin=$(cat); [ -z "$in" ] && exit 0; [ "$in" = "x  f.AppImage" ] && [ "$SUM" = ok ]\n`, { mode: 0o755 });
    const run = (env, v = "0.69.12") => {
      const w = mkdtempSync(join(dir, "w-"));
      const r = spawnSync("sh", ["-c", bodyFor(v), "sh", w], { env: { PATH: `${bin}:${process.env.PATH}`, TAG: `v${v}`, ...env }, encoding: "utf8" });
      return r.stdout.split("\n").filter((l) => l === "VERIFIED" || l === "DONE").join(" ");
    };
    const ok = { DL: "ok", SUM: "ok", NEW: "ok", OLD: "ok" };
    assert.equal(run(ok), "VERIFIED DONE");
    assert.equal(run({ ...ok, NEW: "no" }), "VERIFIED DONE", "a release attested in awebai passes by the second form");
    assert.equal(run({ ...ok, NEW: "no" }, "0.9.1"), "VERIFIED DONE");
    assert.equal(run({ ...ok, OLD: "no" }), "VERIFIED DONE");
    assert.equal(run({ ...ok, OLD: "no" }, "0.70.0"), "VERIFIED DONE");
    assert.equal(run({ ...ok, NEW: "no", OLD: "no" }), "DONE", "no attestation, no VERIFIED");
    for (const v of ["0.69.13", "0.70.0", "1.0.0", "0.100.0"]) {
      assert.equal(run({ ...ok, NEW: "no" }, v), "DONE", `${v} is not trusted on an awebai attestation`);
    }
    assert.equal(run({ ...ok, SUM: "no" }), "DONE", "a failed checksum never falls through to the second form");
    assert.equal(run({ ...ok, SUMS_FILE: "other.AppImage" }), "DONE", "a SHA256SUMS.txt with no line for the file is no checksum");
    assert.equal(run({ ...ok, DL: "no" }), "DONE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the skill's minimums are framework 1.19.0 and oats.aweb 1.33.1, and the catalog meets both", () => {
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes("**A new workspace needs `oats.framework` 1.19.0 or later**"));
  assert.ok(flat.includes("is below `1.19.0`, or with aweb `oats.aweb`'s is below `v1.33.1`, this OATS release is older than this skill"));
  assert.ok(flat.includes("its owner pins `oats.framework` 1.19.0 or later"));
  assert.ok(flat.includes("that one never below `v1.33.1`"));
  assert.doesNotMatch(flat, /1\.18\.0|v1\.3[12]\.\d/);
  const fw = catalog.packages["oats.framework"].ref.replace(/^oats-framework\/v/, "");
  const aweb = catalog.packages["oats.aweb"].ref.replace(/^v/, "");
  // The step 4 example and the skeleton's pins show the catalog's versions.
  assert.ok(flat.includes(`for example \`oats-framework/v${fw} v${aweb}\``));
  assert.ok(flat.includes(`oats.framework: v${fw} `) && flat.includes(`oats.aweb: v${aweb} `));
  assert.ok(atLeast(fw, "1.19.0"), `catalog framework ${fw} is below the skill's minimum`);
  assert.ok(atLeast(aweb, "1.33.1"), `catalog oats.aweb ${aweb} is below the skill's floor`);
});

test("a common hostname gets a keyed hash of the machine id, never the id itself", () => {
  assert.ok(skill.includes(`printf 'oats-machine-name:%s' "$(cat /etc/machine-id)" | sha256sum | cut -c1-8`));
  assert.ok(skill.includes(`| shasum -a 256 | cut -c1-8`));
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes("Never the id itself: the whole team sees this name, and the id is confidential (machine-id(5))."));
  assert.doesNotMatch(flat, /first eight characters of `\/etc\/machine-id`|IOPlatformUUID` on macOS, lowercased/);
});

test("a new workspace with aweb defaults to aweb tasks, and to `tasks: none` only beside a tracker it found", () => {
  const flat = skill.replace(/\s+/g, " ");
  // The skeleton carries the tasks default; the rule says when it is `none`.
  assert.match(skill, /\n  tasks: \{ oats\.aweb-tasks: \{ from: package \} \}\s+# or `tasks: none` \(step 1\)\n/);
  assert.ok(flat.includes("The default is aweb's task list (`oats.aweb-tasks`). It gives way only to a tracker the person already uses, which you find, never ask about"));
  // Issues switched on are GitHub's default, so only a used issue list is a tracker.
  assert.ok(flat.includes("`gh issue list -R <owner>/<repo> --state all --limit 1 --json number --jq length --search "));
  assert.ok(flat.includes("Issues switched on but unused are no tracker"));
  assert.ok(flat.includes("step 7 writes `tasks: none`"));
  assert.ok(flat.includes("Ask only when unsure, as the final-values message's one open line, prefilled with the answer you'd pick: ticket keys the person didn't name"));
  assert.doesNotMatch(flat, /no `tasks:` default/);
  // Onboarding neither edits the team's instructions nor installs the wake broker: the first task opts the
  // team in, and /oats-host-delivery installs the broker where a home needs it.
  assert.doesNotMatch(skill, /AWEB_TASKS_LINE|aw instructions set|oats aweb wake install/);
  // Beside a tracker, the hand-off keeps aweb's list empty.
  assert.ok(flat.includes("Leave aweb's task list empty: one task there opts your whole group in to it. To use aweb's task list instead, ask the setup assistant."));
  // Every path reaches item 6, the hand-over records the choice, and the found-list and no-messaging skeletons carry no tasks line.
  assert.ok(flat.includes("- Tasks (new workspace with aweb): oats.aweb-tasks | none: the agents use"));
  assert.ok(flat.includes("`tasks: none` with one. On a machine found-list, leave it out."));
  assert.ok(flat.includes("leave out the `oats.aweb` line, the `messaging` line, the `tasks` line, `teams` and `defaultTeam`"));
  // The issues check is pinned to recent, human issues, and a non-GitHub project is a question, not a default.
  assert.ok(flat.includes(`--search "updated:>=<date 180 days ago> -author:app/renovate -author:app/dependabot"`));
  assert.ok(flat.includes("a project kept somewhere other than GitHub (its issues can't be read)"));
  assert.ok(flat.includes("Now run step 1's GitHub-issues check if it waited for this login"));
  assert.ok(flat.includes("ask now in one line, prefilled with their GitHub issues (`tasks: none`)"));
  // The setup expert's tailor skill keeps the default rather than adding a second tasks provider.
  const tailor = read("oats-package/capabilities/oats-onboarding/skills/oats-tailor-workspace/SKILL.md").replace(/\s+/g, " ");
  assert.ok(tailor.includes("with `oats.aweb-tasks`, keep it unless the person switches"));
  assert.ok(tailor.includes("(`E_SLOT_CONFLICT`)"));
});

test("pi's aweb extension is installed without its bundled skills", () => {
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes("then its entry in pi's `settings.json` set to load none of the skills it bundles"));
  assert.ok(skill.includes('process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),".pi","agent")'));
  assert.ok(skill.includes("skills:[]}:e)"));
  assert.ok(flat.includes("pi's aweb extension, without its skills (pi only)"));
});

// The onboarding VM campaign's second round of newcomer runs on fresh VMs (#1665).
test("getting-started: the whole file is read, never a summary", () => {
  const raw = "curl -fsSL https://raw.githubusercontent.com/oats-project/oats/main/skills/oats-getting-started/SKILL.md";
  const [, front, body] = skill.split(/^---\n/m);
  const description = front.replace(/\s+/g, " ");
  assert.ok(description.includes(`Download this file whole (\`${raw}\`) and follow it as written: a summary of it is not the procedure.`), "the front-matter description says so");
  assert.ok(body.trimStart().startsWith(`**Read this whole file, never a summary of it.**`), "the body's first line says so");
  assert.ok(body.slice(0, body.indexOf("# Getting started")).replace(/\s+/g, " ").includes(`download it whole with \`${raw}\` and follow it as written`));
  assert.ok(read("README.md").includes(raw), "the README's download command is the same URL");
});

test("getting-started: one change per command, and a refused command is asked about, never re-sliced", () => {
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes("Run each change on the list as its own command, never batched with other changes, so that check sees it by the name their yes gave it (a fenced block below that makes one change on the list counts as one)."));
  assert.ok(flat.includes("never run it another way (another shell, a script, a window you open), and never split it into pieces or re-run its parts, `sudo` included: ask the person once, naming the change, whether you may make it, and try again once on their yes."));
});

test("getting-started: the time budget, and the Desktop's download waited on for about a minute only", () => {
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes("**The time budget.** The whole setup should take a few minutes, and only seconds of the person's time"));
  assert.ok(flat.includes("Don't wait more than about a minute for the Desktop's background download once the CLI is installed: if it hasn't verified by then, go on without the Desktop and record that in the hand-over (the person can install it later with the setup expert, through `/oats-upgrade`)."));
  assert.ok(!flat.includes("the setup expert installs it later"), "the setup expert has no Desktop step of its own");
  // /oats-upgrade is the route that installs it later: its Desktop step covers a host without one.
  const upgrade = read("oats-package/capabilities/oats-setup/skills/oats-upgrade/SKILL.md").replace(/\s+/g, " ");
  assert.ok(upgrade.includes("On a host without it, ask whether they want it installed: a getting-started hand-over whose Desktop line says \"not installed\" left it to this skill."));
  assert.ok(upgrade.includes("**The Desktop**, where it is installed, and on a host without it when the person wants it: version `$V`"));
  assert.ok(upgrade.includes("A first install is the same step, and the same release's Desktop"));
  assert.ok(flat.includes("Run this once: it waits up to a minute for a `DONE` line"));
  assert.ok(!flat.includes("up to five times"), "no five-minute wait for the download");
  assert.ok(skill.includes(`for i in $(seq 60); do grep -qx DONE "<W>.log" && break; sleep 1; done`));
});

test("getting-started: a terminal window that systemd-run can't open is started directly before a typed command", () => {
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes(`If \`systemd-run\` fails (for example "Failed to connect to bus", when there is no user session bus), start the terminal directly, detached, before you give them a command to type: \`setsid -f xdg-terminal-exec sh "F" </dev/null >/dev/null 2>&1\`, or \`setsid -f x-terminal-emulator -e sh "F" </dev/null >/dev/null 2>&1\`.`));
  // Without -f and the redirections, setsid runs the terminal in the foreground and the agent's command blocks until the window closes.
  assert.ok(!/setsid (?!-f )/.test(flat), "every setsid start is detached");
  assert.ok(flat.includes(`when they are unset, don't guess them: take "When no window opens".`));
  // Either way the window is asked about, never assumed.
  const fallback = flat.indexOf("setsid -f xdg-terminal-exec");
  assert.ok(fallback > 0 && fallback < flat.indexOf("ask whether the window opened (a command that started is no proof of one)"));
});

test("getting-started: gh's login is always checked, even right after step 2 installs gh, before a device login", () => {
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes("Always run this check, even when step 2 just installed gh (an existing gh config or `GH_TOKEN` may already log it in), and start the device login below only if it says gh is not logged in."));
  assert.ok(flat.indexOf("Always run this check, even when step 2 just installed gh") < flat.indexOf("nohup gh auth login --web"));
});

test("getting-started: a monorepo host's two setup files are on the one yes, and committed without asking again", () => {
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes("or, when the host is an existing repository (a monorepo), the two setup files committed and pushed straight to `<owner>/<repo>`'s default branch, which runs its automatic checks or deploys if it has any (or a pull request, step 7)."));
  assert.ok(flat.includes("**A monorepo:** push the commit to its default branch on step 1's yes, which named it, without asking again; show the person the files only if they ask."));
  assert.ok(!flat.includes("commit to its default branch only on their yes"), "no second question for the monorepo commit");
  // A shared repository, a protected branch or a refused push takes a pull request, and the hand-over is written only after it merged.
  assert.ok(flat.includes("When others can push to the repository (`gh api repos/<owner>/<repo>/collaborators --jq length` prints more than 1, or fails), its default branch `<branch>` is protected (`gh api repos/<owner>/<repo>/branches/<branch> --jq .protected` prints `true`, `gh api repos/<owner>/<repo>/rules/branches/<branch> --jq length` prints more than 0, or either fails), or the push is refused: push a branch instead, open a pull request, tell them, and stop until it is merged."));
  assert.ok(flat.includes("skeleton committed (pushed | merged from <url>)"));
  assert.ok(!flat.includes("in pull request <url>"), "the spawn never waits on an open pull request");
});

test("getting-started: the hand-off is in plain words; what the person may want later goes to the hand-over file", () => {
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes(`name no versions (Git's, OATS's or any other), no package sources (a PPA, say) and no internal flags or codes (a "development-channel flag", a "channel-not-connected", say). When you name the setup expert as the Desktop lists it, use its display form, never its instance name. Anything they may want to know later goes in the hand-over file, for the setup expert, not in this message.`));
  assert.ok(flat.includes("- For the person, later: <what they may want to know but the hand-off message leaves out"));
});

test("getting-started: pi's skills filter matches @awebai/pi exactly, and Claude's plugin skill is the named gap", () => {
  const line = skill.match(/^node -e '(const fs=require\("fs"\).*)'$/m);
  assert.ok(line, "the pi settings one-liner");
  assert.ok(line[1].includes(String.raw`const ours=(e)=>/^npm:@awebai\/pi(@|$)/.test(`));
  assert.ok(!line[1].includes('.startsWith("npm:@awebai/pi")'), "a prefix match would touch @awebai/pi-… packages");
  // The regex the skill itself runs, not a copy of it.
  const pattern = new RegExp(line[1].match(/const ours=\(e\)=>\/(.*?)\/\.test\(/)[1]);
  for (const s of ["npm:@awebai/pi", "npm:@awebai/pi@0.4.0"]) assert.ok(pattern.test(s), s);
  for (const s of ["npm:@awebai/pi-tools", "npm:@awebai/pi-x@1.0.0", "npm:@awebai/oats-pi@1.0.0"]) assert.ok(!pattern.test(s), s);
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes("pi's extension is installed without its skills"));
  assert.ok(flat.includes("Claude's aweb channel plugin still carries one skill of its own, until aweb ships it without (a known gap)."));
  assert.ok(!flat.includes("OATS puts no machine-wide skills on a computer"), "no claim the Claude plugin contradicts");
});

// The onboarding VM campaign's further newcomer runs (#1665).
test("getting-started: the machine's round is always asked, even under a prompt that says to ask nothing more", () => {
  const flat = skill.replace(/\s+/g, " ");
  const intro = flat.slice(flat.indexOf("**A machine found-list**"), flat.indexOf("**How to work.**"));
  assert.ok(intro.includes("Step 1's machine round is always asked, even when the prompt that started you says to ask for nothing more"));
  assert.ok(intro.includes("Its one yes, naming the changes, is the consent your harness's permission check reads; without it, the check refuses each change on its own (the repository, the aweb signup, the folder trust), and each costs the person a round. After that yes, nothing more is asked."));
  const round = flat.slice(flat.indexOf("**The machine's round.**"), flat.indexOf("## 2. Check"));
  assert.ok(round.includes("Ask it even when your prompt says to ask nothing more (above)."));
});

test("getting-started: the Desktop's system libraries are among step 2's checks, run before step 1's list", () => {
  const loop = `for l in libasound.so.2 libfuse.so.2; do PATH="$PATH:/sbin:/usr/sbin" ldconfig -p | grep -q "$l" || echo "MISSING $l"; done`;
  assert.equal(skill.split(loop).length, 2, "one copy of the check");
  const step2 = skill.indexOf("## 2. Check"), check = skill.indexOf(loop);
  // With the read-only checks at step 2's head, before the installs (the Linux bullets).
  assert.ok(check > step2 && check < skill.indexOf("- **Versions:**", step2), "beside the other read-only checks");
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes("On Linux x64 they include the Desktop's system libraries: a missing one goes on the list as a system package, dropped if they decline the Desktop, so the Desktop's install needs no second yes."));
  assert.ok(flat.includes("**ALSA missing:** the Desktop needs it, so step 1's list names its package, to install with the other system packages"));
});

test("tailoring: tasks has one rule per case, aweb's list kept by default and an offer beside a tracker", () => {
  const tailor = read("oats-package/capabilities/oats-onboarding/skills/oats-tailor-workspace/SKILL.md").replace(/\s+/g, " ");
  assert.ok(tailor.includes("Author coordination and knowledge, and tasks when its rule below says so"));
  assert.ok(!tailor.includes("Author coordination, knowledge and tasks as plain capabilities"), "tasks is not authored in every case");
  assert.ok(tailor.includes("**aweb's task list by default** (no tracker found): with `oats.aweb-tasks`, keep it unless the person switches. Author no tasks capability."));
  assert.ok(tailor.includes("**Beside a tracker** (`tasks: none`: GitHub issues, or another tasks tool): offer to make a tasks capability for their use case."));
  assert.ok(tailor.includes("their labels and states, who files issues and who closes them, and what agents may do there"));
  assert.ok(tailor.includes("as this workspace's own capability (over `gh issue` for GitHub issues)"));
  assert.ok(tailor.includes("Don't leave `none` without asking, and don't pin a generic provider in its place."));
  assert.ok(tailor.includes("default (`E_SLOT_CONFLICT`): the workspace's tasks capability goes in `defaults.tasks`."));
  assert.ok(!tailor.includes("the tracker's capability replaces `none`"), "the old rule that pinned a provider beside a tracker");
  assert.ok(read("docs/integrations.md").replace(/\s+/g, " ").includes("The setup expert then offers to make a tasks capability of the workspace's own for that tracker"));
  // The conversation is the setup expert's own; a sub-agent writes the files; the manifest fills the tasks slot.
  assert.ok(tailor.includes("You hold that conversation with the person yourself; a sub-agent only writes the files after it. Its manifest declares `\"layer\": \"tasks\"`"));
  // getting-started promises an offer, not a connection.
  const gs = skill.replace(/\s+/g, " ");
  assert.ok(gs.includes("the setup assistant offers to connect them\") and step 7 writes `tasks: none`; the setup expert offers to connect the tracker with the person later."));
  assert.ok(gs.includes("Your agents use your <GitHub issues | tracker>; the setup assistant offers to connect them."));
  assert.ok(!/setup assistant connects them|setup expert connects the tracker/.test(gs));
});

test("a soul whose declared harness differs from this machine's '*' gets its own entry where souls are added later", () => {
  const tailor = read("oats-package/capabilities/oats-onboarding/skills/oats-tailor-workspace/SKILL.md").replace(/\s+/g, " ");
  const pins = read("oats-package/capabilities/oats-setup/skills/oats-package-pins/SKILL.md").replace(/\s+/g, " ");
  for (const [name, text] of [["oats-tailor-workspace", tailor], ["oats-package-pins", pins]]) {
    assert.match(text, /`souls\.launch\."\*"`[^.]*wins over [^.]*own `launch:`/, `${name} says '*' wins over a new soul's launch:`);
    assert.ok(text.includes("`oats soul launch set <key> --harness <its harness> --plan`, then without `--plan`"), `${name} plans the per-soul entry first`);
    assert.ok(text.includes("`--model <its model>` when it names one"), `${name} carries the model`);
    assert.ok(text.includes("plan first (from OATS 0.53.0)"), `${name} names the OATS version that has the command`);
    assert.match(text, /differs from [^.]*and is installed and logged in on this machine/, `${name} keeps a declared harness only when it is installed here`);
    assert.ok(text.includes("A declared harness that isn't installed here stays under `'*'`, so the soul can run; tell the person."), `${name} leaves a missing harness under '*'`);
  }
  // '*' replaces the model too: a reviewer on the developers' harness with another model keeps it, and its preview proves it.
  for (const [name, text] of [["oats-package-pins", pins], ["oats-getting-started", skill.replace(/\s+/g, " ")]]) {
    assert.match(text, /Check a (new )?reviewer soul by its model too, since `'\*'` replaces the model as well as the harness/, `${name} checks the reviewer's model`);
    assert.ok(text.includes("`--harness <its harness> --model <its model>`"), `${name} gives the reviewer its own entry with its model`);
    assert.ok(text.includes("must show a `launch.effective` model from a family other than the developers'"), `${name} checks the reviewer's preview`);
  }
});

test("getting-started: a person with no GitHub account is helped to make one, and gh is installed for them", () => {
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes("**No GitHub account.** Their agents' shared setup and their projects live on GitHub. When gh is not logged in, ask in the same message whether they have a GitHub account."));
  assert.ok(flat.includes("gh goes on the list of changes like any missing tool, and you install it."));
  assert.ok(flat.includes("open GitHub's sign-up page in their browser first: `open https://github.com/signup` on macOS, `xdg-open https://github.com/signup` on Linux"));
  assert.ok(flat.includes("in their browser, never in this conversation"), "the account's password never reaches the agent");
  // The sign-up comes before the device login, which runs unchanged after it.
  assert.ok(flat.indexOf("open GitHub's sign-up page") < flat.indexOf("nohup gh auth login --web"));
});

test("getting-started: a join never runs aw team ensure (it would make a second team for the same repository)", () => {
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes("**Run `aw team ensure` when joining an existing workspace.** It is only step 5's, for a new workspace."));
  // Every `team ensure` command line sits in step 5, which only a new workspace with the person's sign-in runs.
  const step5 = skill.indexOf("## 5. Optional: the team on your own aweb account");
  const step6 = skill.indexOf("\n## 6.", step5);
  assert.ok(step5 > 0 && step6 > step5);
  for (const m of skill.matchAll(/aw [^\n`]*team ensure --workspace-key/g)) {
    assert.ok(m.index > step5 && m.index < step6, "an `aw team ensure` command outside step 5");
  }
  assert.ok(flat.includes("**Only for a new workspace with aweb whose person chose, in step 1, the team on their own aweb account now.**"));
});
