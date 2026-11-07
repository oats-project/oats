// A Desktop process that runs as Node (the backend, the liveness collector) is started with the
// environment its parent was started with, so the packaged executable starts exactly as before,
// and then drops what the Desktop and its packaging added: everything it starts inherits the
// user's environment, with no change at the places that start a program.
//
// Clean before loading modules that snapshot the environment: the backend first captures and removes
// its control token, then imports this module; the liveness collector imports this first. Imports
// are evaluated in source order, each completely before the next. The cleaner imports only
// cli-environment.mjs and its control-environment leaf, so no effectful code can run ahead of it.
// A library must never import this: it changes the environment of whoever does.
import { cliEnvironment } from "./cli-environment.mjs";

/** The launch environment after token capture. Its one use: the backend starts the collector with it. */
export const launchEnvironment = Object.freeze({ ...process.env });

// In place: process.env is never reassigned.
const user = cliEnvironment(launchEnvironment);
for (const name of Object.keys(launchEnvironment)) {
  if (!Object.hasOwn(user, name)) delete process.env[name];
  else if (user[name] !== launchEnvironment[name]) process.env[name] = user[name];
}
