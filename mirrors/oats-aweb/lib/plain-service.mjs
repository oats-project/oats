// The one shape a service URL from another party's text (an invite, a root's workspace.yaml) must
// have before it is used or shown: http(s), a host, an optional port and no path but `/` or `/api`,
// at most 2048 characters. Nothing else passes, so no credential (userinfo, a query, a path
// segment) and no stray text (WHATWG URL parsing drops tabs and newlines; this does not) gets through.
const PLAIN_SERVICE_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?(?:\/api\/?|\/)?$/;

/** `value` when it is a plain service URL, else undefined. */
export function plainServiceUrl(value) {
  return typeof value === 'string' && value.length <= 2048 && PLAIN_SERVICE_RE.test(value) ? value : undefined;
}

// A registry origin (the AWID registry a team's certificates live in) has the same strictness
// with no path at all: http(s), a host, an optional port and at most a trailing `/`. A command
// a person may run is built from it, so nothing else (userinfo, a path, a query, a fragment,
// whitespace, shell text) passes.
const REGISTRY_ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/?$/;

/** `value` when it is a plain registry origin, else undefined. */
export function registryOriginUrl(value) {
  return typeof value === 'string' && value.length <= 2048 && REGISTRY_ORIGIN_RE.test(value) ? value : undefined;
}
