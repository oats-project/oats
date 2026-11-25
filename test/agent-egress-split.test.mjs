import assert from "node:assert/strict";
import test from "node:test";
import { policyHash } from "../container/agent/egress/policy.mjs";

// The cross-language vector from the split-host spec. It exercises the hash
// helper only; it is not a valid compilePolicy input.
const vectorPolicy = {"schema":1,"humanOrigin":"https://approve.example.invalid","frontAddress":"172.30.0.2","privateIngressAddresses":[],"deniedAddresses":["10.20.0.11"],"targets":{"signer":{"origin":"https://prepare.example.invalid","addresses":["203.0.113.10"]},"aweb":{"origin":"https://aweb.example.invalid","addresses":["203.0.113.10"]}},"note":"é "};

test("policyHash matches the pinned cross-language vector", () => {
  assert.equal(policyHash(vectorPolicy), "sha256:89ccf024cd7fc89c045b95339895dc3f044eb248cf09159cdb876d787055b5d4");
});

test("policyHash sorts keys recursively, keeps array order and ignores declaration order", () => {
  assert.equal(policyHash({b:[2,1],a:{d:null,c:true}}), policyHash({a:{c:true,d:null},b:[2,1]}));
  assert.notEqual(policyHash({b:[2,1]}), policyHash({b:[1,2]}));
});

test("policyHash refuses values that are not portable JSON", () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [undefined, {a:undefined}, [()=>1], {a:NaN}, {a:Infinity}, {a:1.5}, {a:2**53}, {"é":1},
    {a:"\ud800"}, {a:1n}, {a:Symbol("s")}, {a:new Date(0)}, {a:new Map()}, cyclic]) {
    assert.throws(() => policyHash(value), /policyHash/, String(value?.a ?? value));
  }
});
