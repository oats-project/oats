import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { supervise } from "../container/agent/supervisor.mjs";

test("invalid registry input refuses before any supervised child starts", async t => {
  const directory = mkdtempSync(join(tmpdir(), "agent-registry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previous = process.env.AWID_REGISTRY_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.AWID_REGISTRY_URL;
    else process.env.AWID_REGISTRY_URL = previous;
  });
  let launches = 0;
  const lines = [];
  process.env.AWID_REGISTRY_URL = "https://secret:credential@registry.example.test/path?query#fragment";
  const result = await supervise({ registryDirectory: join(directory, "registry"),
    onSignal: () => () => {}, say: line => lines.push(line),
    spawnChild() { launches++; throw new Error("unexpected child"); } });
  assert.equal(result, 1);
  assert.equal(launches, 0);
  assert.match(lines.join("\n"), /AWID_REGISTRY_URL.*https:\/\//);
  assert.doesNotMatch(lines.join("\n"), /credential|query|fragment/);
});

function registryFixture(t, value) {
  const root = mkdtempSync(join(tmpdir(), "agent-registry-"));
  const directory = join(root, "registry");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.AWID_REGISTRY_URL;
  if (value === undefined) delete process.env.AWID_REGISTRY_URL;
  else process.env.AWID_REGISTRY_URL = value;
  t.after(() => {
    if (previous === undefined) delete process.env.AWID_REGISTRY_URL;
    else process.env.AWID_REGISTRY_URL = previous;
  });
  return { directory, file: join(directory, "registry-url") };
}

test("registry runtime data is private and ready before the broker launches", async t => {
  const { directory, file } = registryFixture(t, "https://registry.example.test/");
  let observed;
  await supervise({ registryDirectory: directory, onSignal: () => () => {}, say() {},
    spawnChild() {
      observed = existsSync(file) ? { value: readFileSync(file, "utf8"),
        directoryMode: statSync(directory).mode & 0o777, fileMode: statSync(file).mode & 0o777 } : null;
      throw new Error("stop at owned process boundary");
    } });
  assert.deepEqual(observed, { value: "https://registry.example.test/", directoryMode: 0o700, fileMode: 0o400 });
});

test("unset registry input removes stale runtime data before any child launches", async t => {
  const { directory, file } = registryFixture(t, undefined);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(file, "https://stale.example.test", { mode: 0o400 });
  let stale;
  await supervise({ registryDirectory: directory, onSignal: () => () => {}, say() {},
    spawnChild() { stale = existsSync(file); throw new Error("stop at owned process boundary"); } });
  assert.equal(stale, false);
});


test("registry data is revalidated on read and absent data has no fallback", async t => {
  const { readRegistryInput } = await import("../container/agent/agent-registry.mjs");
  assert.equal(typeof readRegistryInput, "function", "shell sessions must read validated data");
  const { directory, file } = registryFixture(t, undefined);
  assert.equal(readRegistryInput(directory), undefined);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(file, "https://registry.example.test/", { mode: 0o400 });
  assert.equal(readRegistryInput(directory), "https://registry.example.test/");
  for (const value of ["", "https://registry.example.test/path", "https://user@registry.example.test", "https://registry.example.test?", "https://registry.example.test#", "https://registry.example.test/../", "https://registry.example.test\n", "$(false)"]) {
    chmodSync(file, 0o600); writeFileSync(file, value); chmodSync(file, 0o400);
    assert.throws(() => readRegistryInput(directory), /AWID_REGISTRY_URL/);
  }
});

test("unreadable or substituted registry data is refused", async t => {
  const { readRegistryInput } = await import("../container/agent/agent-registry.mjs");
  assert.equal(typeof readRegistryInput, "function");
  const { directory, file } = registryFixture(t, undefined);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(file, "https://registry.example.test", { mode: 0o000 });
  assert.throws(() => readRegistryInput(directory), /AWID_REGISTRY_URL/);
  rmSync(file); symlinkSync("/dev/null", file);
  assert.throws(() => readRegistryInput(directory), /AWID_REGISTRY_URL/);
});


function shellProfile(t, directory) {
  // Relocate only the image's two fixed filesystem bindings into this fixture.
  const helper = join(directory, "..", "agent-registry.mjs");
  const source = readFileSync(new URL("../container/agent/agent-registry.mjs", import.meta.url), "utf8")
    .replace('REGISTRY_DIRECTORY = "/tmp/agent-registry"', `REGISTRY_DIRECTORY = ${JSON.stringify(directory)}`);
  writeFileSync(helper, source);
  const profile = readFileSync(new URL("../container/agent/agent-trust.sh", import.meta.url), "utf8")
    .replace("/usr/local/bin/node", JSON.stringify(process.execPath))
    .replace("/usr/local/lib/agent-registry.mjs", JSON.stringify(helper));
  return spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", profile + '\nprintf "shell-open:%s" "${AWID_REGISTRY_URL-unset}"'],
    { env: { PATH: "/usr/bin:/bin", HOME: directory, AWID_REGISTRY_URL: "https://ambient.example.test" }, encoding: "utf8", timeout: 3000 });
}

test("the immutable profile selects configured registry data without inheriting ambient values", t => {
  const { directory, file } = registryFixture(t, undefined);
  const absent = shellProfile(t, directory);
  assert.equal(absent.status, 0);
  assert.equal(absent.stdout, "shell-open:unset");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(file, "https://registry.example.test/", { mode: 0o400 });
  const present = shellProfile(t, directory);
  assert.equal(present.status, 0);
  assert.equal(present.stdout, "shell-open:https://registry.example.test/");
  assert.equal(present.stderr, "");
});

test("a bad registry file keeps the shell open with an explicit invalid selector", t => {
  const { directory, file } = registryFixture(t, undefined);
  mkdirSync(directory, { mode: 0o700 });
  const marker = join(directory, "must-not-execute");
  writeFileSync(file, `$(touch ${JSON.stringify(marker)})`, { mode: 0o400 });
  for (const mode of [0o400, 0o000]) {
    chmodSync(file, mode);
    const result = shellProfile(t, directory);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "shell-open:invalid:");
    assert.match(result.stderr, /AWID_REGISTRY_URL.*\/tmp\/agent-registry\/registry-url/);
    assert.equal(result.stderr.trim().split("\n").length, 1);
    assert.equal(existsSync(marker), false);
  }
});

test("exact acceptance admits only the configured registry selector alongside fixed CA trust", async () => {
  const { agentEnvironment } = await import("../container/agent/accept.mjs");
  const image = ["HOME=/state/home", "PATH=/usr/bin", "AWEB_DELIVERY=session"];
  assert.deepEqual(agentEnvironment(image, false, "https://registry.example.test"), [...image, "AWID_REGISTRY_URL=https://registry.example.test"]);
  assert.deepEqual(agentEnvironment(image, true, "https://registry.example.test"), [...image,
    "SSL_CERT_FILE=/etc/agent-trust/ca.pem", "NODE_EXTRA_CA_CERTS=/etc/agent-trust/ca.pem", "AWID_REGISTRY_URL=https://registry.example.test"]);
  assert.deepEqual(agentEnvironment(image), image);
  assert.throws(() => agentEnvironment(image, false, "http://registry.example.test"), /AWID_REGISTRY_URL/);
});

test("registry helper imports also work from a stdin Node program", () => {
  const file = new URL("../container/agent/agent-registry.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    input: `const {registryOrigin}=await import(${JSON.stringify(file)}); console.log(registryOrigin('https://registry.example.test'));`,
    encoding: "utf8", timeout: 3000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "https://registry.example.test");
});

test("runtime acceptance refuses a missing, invalid or differing registry snapshot", async () => {
  const { registryCheck } = await import("../container/agent/accept.mjs");
  assert.equal(typeof registryCheck, "function");
  const { runInNewContext } = await import("node:vm");
  const check = (value, result) => runInNewContext(`(${registryCheck.toString()})()`, {
    process: { execPath: "/usr/local/bin/node", env: value === undefined ? {} : { AWID_REGISTRY_URL: value } },
    require(name) {
      if (name === "node:assert/strict") return assert;
      assert.equal(name, "node:child_process");
      return { spawnSync(file, args) { assert.equal(file, "/usr/local/bin/node");
        assert.deepEqual([...args], ["/usr/local/lib/agent-registry.mjs", "--profile"]); return result; } };
    },
  });
  assert.match(check(undefined, { status: 0, stdout: "" }), /registry/);
  assert.match(check("https://registry.example.test", { status: 0, stdout: "https://registry.example.test" }), /registry/);
  for (const result of [{ status: 1, stdout: "" }, { status: 0, stdout: "" }, { status: 0, stdout: "https://different.example.test" }]) {
    assert.throws(() => check("https://registry.example.test", result), /AWID_REGISTRY_URL/);
  }
});
