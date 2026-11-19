## Fixed

- The egress ingress routine names its signer-role requirement before sending
  controls when given a policy without signer. Runtime boundary controls now
  share the compiler's canonical role order, including in emitted probe
  programs. The packaged CLI keeps its values-withheld refusal diagnostic.
