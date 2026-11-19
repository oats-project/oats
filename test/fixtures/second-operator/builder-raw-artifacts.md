# Raw artifacts for the second-operator regression fixtures

All four, with their **inputs** as well as their outputs — a fixture needs the request that produced it. Captured on macOS, node 26.8.2, npm 11.19.1, `@awebai/oats@0.24.1` installed directory-locally. Absolute paths are the operator's acceptance directory and are inherent to the capture; substitute a fixture root when you adopt them.

Ordering note: the runs below are the post-approval state. Both capability approvals (`oats.okf` artifact set `sha256-32994916e1cdd8dd5f7d24ea3b91db872f74b5d6958c50c37dba82d606f507d4`, `oats.aweb` artifact set `sha256-5fbf5303cd21ce34a754090fbcaa2411b3b48181d80b13ab78e174e05a709da4`) had already succeeded, so `approvalRequired` is `[]` on all three selections and the only remaining problems are the two you are fixing.


## 1a. inspect — request

```json
{
  "deployment": "/fixture/second-operator/deployment",
  "workTarget": "/fixture/second-operator/project",
  "source": "oats-kernel-expert",
  "origin": {
    "kind": "operator",
    "document": { "kind": "operator", "id": "alex-p15-acceptance" },
    "pointer": "/source"
  },
  "workspace": {
    "source": "git:github.com/awebai/oats",
    "origin": {
      "kind": "operator",
      "document": { "kind": "operator", "id": "alex-p15-acceptance" },
      "pointer": "/workspace"
    }
  },
  "member": {
    "source": "git:github.com/awebai/oats",
    "origin": {
      "kind": "operator",
      "document": { "kind": "operator", "id": "alex-p15-acceptance" },
      "pointer": "/member"
    }
  }
}
```


## 1b. inspect — result (exit 0, stderr empty)

```json
{
  "schemaVersion": 1,
  "ok": true,
  "result": {
    "schemaVersion": 1,
    "status": "ready-for-preparation",
    "deployment": {
      "schemaVersion": 1,
      "status": "ready",
      "deployment": {
        "path": "/fixture/second-operator/deployment",
        "state": "absent"
      },
      "managedState": [],
      "advice": [],
      "effects": {
        "writes": false,
        "deletes": false,
        "installs": false,
        "enrollment": false
      }
    },
    "workTarget": {
      "path": "/fixture/second-operator/project",
      "state": "existing",
      "git": {
        "present": false,
        "kind": null
      }
    },
    "source": {
      "location": "git:https://github.com/awebai/oats.git",
      "identity": {
        "kind": "git-soul",
        "repository": {
          "kind": "provider-repository",
          "provider": "github",
          "host": "github.com",
          "id": "1333348509"
        },
        "exportPath": "souls/oats-kernel-expert"
      },
      "revision": {
        "identity": {
          "kind": "provider-repository",
          "provider": "github",
          "host": "github.com",
          "id": "1333348509"
        },
        "remote": "git:https://github.com/awebai/oats.git",
        "selector": "caa341f34009e37006567419a983d5a743037a79",
        "commit": "caa341f34009e37006567419a983d5a743037a79",
        "provenance": [
          {
            "document": {
              "kind": "source",
              "source": "git:https://github.com/awebai/oats.git",
              "revision": "7f519053490b5da6b24c451687d4fbe12063bfa9",
              "path": "oats-workspace.yaml",
              "integrity": {
                "format": "oats.bytes.v1",
                "value": "sha256-1a844ac35774dac2ecfb3466504a998ffaf51f320f21bb2f4785dbeff4c788f7"
              }
            },
            "pointer": "/imports/1",
            "span": {
              "start": 1013,
              "end": 1168
            },
            "kind": "import-adoption"
          }
        ]
      },
      "alias": "oats-kernel-expert",
      "exportPath": "souls/oats-kernel-expert",
      "definition": "souls/oats-kernel-expert/soul.yaml",
      "roots": [
        "oats-package",
        "souls/oats-kernel-expert"
      ],
      "provenance": [
        {
          "document": {
            "kind": "source",
            "source": "git:https://github.com/awebai/oats.git",
            "revision": "caa341f34009e37006567419a983d5a743037a79",
            "path": "oats.yaml",
            "integrity": {
              "format": "oats.bytes.v1",
              "value": "sha256-87a8da58b4de8aea4cfc3eded596a4999bcdda527d946a5a24a8a85941632777"
            }
          },
          "pointer": "/exports/souls/1",
          "span": {
            "start": 254,
            "end": 421
          },
          "kind": "source-export"
        }
      ],
      "adoptionPresent": false,
      "exports": {
        "souls": [
          {
            "path": "souls/oats-expert",
            "definition": "souls/oats-expert/soul.yaml",
            "description": "Transitional portable edition of the existing OATS framework expert."
          },
          {
            "path": "souls/oats-kernel-expert",
            "definition": "souls/oats-kernel-expert/soul.yaml",
            "description": "Kernel contracts, rationale, compatibility and trust expertise."
          },
          {
            "path": "souls/oats-desktop-expert",
            "definition": "souls/oats-desktop-expert/soul.yaml",
            "description": "Desktop product, interaction and verification expertise."
          },
          {
            "path": "souls/market-research-expert",
            "definition": "souls/market-research-expert/soul.yaml",
            "description": "Dated, attributable market research and positioning evidence."
          },
          {
            "path": "souls/oats-assistant",
            "definition": "souls/oats-assistant/soul.yaml",
            "description": "Persistent user-facing adoption, configuration and expert handoff."
          }
        ],
        "packages": [
          {
            "path": "oats-package",
            "description": "oats.framework distribution \u2014 oats.core, oats.setup and the optional knowledge-theory capability."
          },
          {
            "path": "capabilities/oats-authoring",
            "description": "Contained authoring capability package; not an implicit workspace default."
          }
        ],
        "knowledge": []
      }
    },
    "workspace": {
      "request": {
        "source": "git:github.com/awebai/oats",
        "origin": {
          "kind": "operator",
          "document": {
            "kind": "operator",
            "id": "alex-p15-acceptance"
          },
          "pointer": "/workspace"
        }
      },
      "identity": {
        "repository": {
          "kind": "provider-repository",
          "provider": "github",
          "host": "github.com",
          "id": "1333348509"
        },
        "path": "oats-workspace.yaml"
      },
      "source": {
        "identity": {
          "kind": "provider-repository",
          "provider": "github",
          "host": "github.com",
          "id": "1333348509"
        },
        "remote": "git:https://github.com/awebai/oats.git",
        "selector": "main",
        "commit": "7f519053490b5da6b24c451687d4fbe12063bfa9",
        "provenance": [
          {
            "kind": "operator",
            "document": {
              "kind": "operator",
              "id": "alex-p15-acceptance"
            },
            "pointer": "/workspace"
          }
        ]
      },
      "name": "oats-development",
      "members": [
        {
          "source": "git:https://github.com/awebai/oats.git"
        },
        {
          "source": "git:https://github.com/awebai/oats-dev.git"
        },
        {
          "source": "git:https://github.com/awebai/oats-okf.git"
        },
        {
          "source": "git:https://github.com/awebai/oats-aweb.git"
        },
        {
          "source": "git:https://github.com/awebai/oats-authoring.git"
        },
        {
          "source": "git:https://github.com/awebai/oats-jira.git"
        },
        {
          "source": "git:https://github.com/awebai/oats-linear.git"
        }
      ],
      "imports": [
        {
          "source": "git:https://github.com/awebai/oats.git",
          "soul": "souls/oats-expert",
          "revision": "caa341f34009e37006567419a983d5a743037a79",
          "alias": "oats-expert",
          "adoptionPresent": false
        },
        {
          "source": "git:https://github.com/awebai/oats.git",
          "soul": "souls/oats-kernel-expert",
          "revision": "caa341f34009e37006567419a983d5a743037a79",
          "alias": "oats-kernel-expert",
          "adoptionPresent": false
        },
        {
          "source": "git:https://github.com/awebai/oats.git",
          "soul": "souls/oats-desktop-expert",
          "revision": "caa341f34009e37006567419a983d5a743037a79",
          "alias": "oats-desktop-expert",
          "adoptionPresent": false
        },
        {
          "source": "git:https://github.com/awebai/oats.git",
          "soul": "souls/market-research-expert",
          "revision": "caa341f34009e37006567419a983d5a743037a79",
          "alias": "market-research-expert",
          "adoptionPresent": false
        },
        {
          "source": "git:https://github.com/awebai/oats.git",
          "soul": "souls/oats-assistant",
          "revision": "caa341f34009e37006567419a983d5a743037a79",
          "alias": "oats-assistant",
          "adoptionPresent": false
        }
      ],
      "catalogs": []
    },
    "context": {
      "kind": "workspace",
      "identity": {
        "repository": {
          "kind": "provider-repository",
          "provider": "github",
          "host": "github.com",
          "id": "1333348509"
        },
        "path": "oats-workspace.yaml"
      }
    },
    "repositoryMembership": {
      "request": {
        "source": "git:github.com/awebai/oats",
        "origin": {
          "kind": "operator",
          "document": {
            "kind": "operator",
            "id": "alex-p15-acceptance"
          },
          "pointer": "/member"
        }
      },
      "result": {
        "schemaVersion": 1,
        "status": "eligible",
        "workspace": {
          "identity": {
            "repository": {
              "kind": "provider-repository",
              "provider": "github",
              "host": "github.com",
              "id": "1333348509"
            },
            "path": "oats-workspace.yaml"
          },
          "revision": "7f519053490b5da6b24c451687d4fbe12063bfa9",
          "document": {
            "kind": "source",
            "source": "git:https://github.com/awebai/oats.git",
            "revision": "7f519053490b5da6b24c451687d4fbe12063bfa9",
            "path": "oats-workspace.yaml",
            "integrity": {
              "format": "oats.bytes.v1",
              "value": "sha256-1a844ac35774dac2ecfb3466504a998ffaf51f320f21bb2f4785dbeff4c788f7"
            }
          }
        },
        "member": {
          "identity": {
            "kind": "provider-repository",
            "provider": "github",
            "host": "github.com",
            "id": "1333348509"
          },
          "revision": "7f519053490b5da6b24c451687d4fbe12063bfa9",
          "document": {
            "kind": "source",
            "source": "git:https://github.com/awebai/oats.git",
            "revision": "7f519053490b5da6b24c451687d4fbe12063bfa9",
            "path": "oats.yaml",
            "integrity": {
              "format": "oats.bytes.v1",
              "value": "sha256-87a8da58b4de8aea4cfc3eded596a4999bcdda527d946a5a24a8a85941632777"
            }
          }
        },
        "evidence": [
          {
            "document": {
              "kind": "source",
              "source": "git:https://github.com/awebai/oats.git",
              "revision": "7f519053490b5da6b24c451687d4fbe12063bfa9",
              "path": "oats-workspace.yaml",
              "integrity": {
                "format": "oats.bytes.v1",
                "value": "sha256-1a844ac35774dac2ecfb3466504a998ffaf51f320f21bb2f4785dbeff4c788f7"
              }
            },
            "pointer": "/members/0",
            "span": {
              "start": 287,
              "end": 322
            },
            "kind": "workspace-admission"
          },
          {
            "document": {
              "kind": "source",
              "source": "git:https://github.com/awebai/oats.git",
              "revision": "7f519053490b5da6b24c451687d4fbe12063bfa9",
              "path": "oats.yaml",
              "integrity": {
                "format": "oats.bytes.v1",
                "value": "sha256-87a8da58b4de8aea4cfc3eded596a4999bcdda527d946a5a24a8a85941632777"
              }
            },
            "pointer": "/workspace",
            "span": {
              "start": 30,
              "end": 65
            },
            "kind": "member-backlink"
          }
        ],
        "problems": []
      }
    },
    "teams": {
      "declared": {},
      "enrollment": "not-performed",
      "privateTeamQualification": "not-evaluated"
    },
    "catalogs": [],
    "problems": [],
    "effects": {
      "deploymentWrites": false,
      "repositoryReads": true,
      "repositoryScratch": "caller-owned",
      "installs": false,
      "activation": false,
      "credentials": false,
      "teams": false,
      "jobs": false
    },
    "omitted": {
      "providerPayloads": true,
      "adoptionValues": true
    }
  }
}
```


## 2a. prepare, VALID stores.oats — request

```json
{
  "deployment": "/fixture/second-operator/deployment",
  "source": "oats-kernel-expert",
  "origin": {
    "kind": "operator",
    "document": {
      "kind": "operator",
      "id": "alex-p15-acceptance"
    },
    "pointer": "/source"
  },
  "workspace": {
    "source": "git:github.com/awebai/oats",
    "origin": {
      "kind": "operator",
      "document": {
        "kind": "operator",
        "id": "alex-p15-acceptance"
      },
      "pointer": "/workspace"
    }
  },
  "member": {
    "source": "git:github.com/awebai/oats",
    "origin": {
      "kind": "operator",
      "document": {
        "kind": "operator",
        "id": "alex-p15-acceptance"
      },
      "pointer": "/member"
    }
  },
  "operator": {
    "policy": {},
    "document": {
      "kind": "operator",
      "id": "alex-p15-acceptance"
    },
    "bindings": {
      "stores.oats": {
        "id": "oats",
        "kind": "git",
        "repository": "https://github.com/awebai/oats-knowledge.git",
        "root": "knowledge",
        "acceptedBranch": "main",
        "pr": {
          "repository": "awebai/oats-knowledge"
        }
      }
    }
  }
}
```


## 2b. prepare, VALID stores.oats — result (exit 1)

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "needs-configuration",
    "message": "preparation is incomplete; no executable resolution was published",
    "details": {
      "status": "needs-configuration",
      "resolution": null,
      "executionBinding": null,
      "source": {
        "source": "git:https://github.com/awebai/oats.git",
        "soul": "souls/oats-kernel-expert",
        "revision": "caa341f34009e37006567419a983d5a743037a79",
        "alias": "oats-kernel-expert"
      },
      "selections": [
        {
          "request": {
            "source": "git:https://github.com/awebai/oats.git@caa341f34009e37006567419a983d5a743037a79",
            "path": "oats-package"
          },
          "artifactSet": "sha256-394980afebd72fec5c840ed01a4fde134185a4b79e17b23ba044b03deb388cc9",
          "approvalRequired": []
        },
        {
          "request": {
            "source": "git:https://github.com/awebai/oats-okf.git@v2.1.1",
            "path": "oats-package"
          },
          "artifactSet": "sha256-32994916e1cdd8dd5f7d24ea3b91db872f74b5d6958c50c37dba82d606f507d4",
          "approvalRequired": []
        },
        {
          "request": {
            "source": "git:https://github.com/awebai/oats-aweb.git@v1.10.3",
            "path": "oats-package"
          },
          "artifactSet": "sha256-5fbf5303cd21ce34a754090fbcaa2411b3b48181d80b13ab78e174e05a709da4",
          "approvalRequired": []
        }
      ],
      "problems": [
        {
          "code": "needs-configuration",
          "message": "provider binding could not be prepared",
          "origins": []
        },
        {
          "code": "provider-not-qualified",
          "message": "selected provider has no matching binding interface",
          "origins": []
        }
      ]
    }
  }
}
```


## 3a. prepare, BOGUS stores.oats — request (nonexistent repository and root)

```json
{
  "deployment": "/fixture/second-operator/deployment",
  "source": "oats-kernel-expert",
  "origin": {
    "kind": "operator",
    "document": {
      "kind": "operator",
      "id": "alex-p15-acceptance"
    },
    "pointer": "/source"
  },
  "workspace": {
    "source": "git:github.com/awebai/oats",
    "origin": {
      "kind": "operator",
      "document": {
        "kind": "operator",
        "id": "alex-p15-acceptance"
      },
      "pointer": "/workspace"
    }
  },
  "member": {
    "source": "git:github.com/awebai/oats",
    "origin": {
      "kind": "operator",
      "document": {
        "kind": "operator",
        "id": "alex-p15-acceptance"
      },
      "pointer": "/member"
    }
  },
  "operator": {
    "policy": {},
    "document": {
      "kind": "operator",
      "id": "alex-p15-acceptance"
    },
    "bindings": {
      "stores.oats": {
        "id": "oats",
        "kind": "git",
        "repository": "https://github.com/awebai/this-repo-does-not-exist.git",
        "root": "nonexistent-root",
        "acceptedBranch": "main",
        "pr": {
          "repository": "awebai/oats-knowledge"
        }
      }
    }
  }
}
```


## 3b. prepare, BOGUS stores.oats — result (exit 1)

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "needs-configuration",
    "message": "preparation is incomplete; no executable resolution was published",
    "details": {
      "status": "needs-configuration",
      "resolution": null,
      "executionBinding": null,
      "source": {
        "source": "git:https://github.com/awebai/oats.git",
        "soul": "souls/oats-kernel-expert",
        "revision": "caa341f34009e37006567419a983d5a743037a79",
        "alias": "oats-kernel-expert"
      },
      "selections": [
        {
          "request": {
            "source": "git:https://github.com/awebai/oats.git@caa341f34009e37006567419a983d5a743037a79",
            "path": "oats-package"
          },
          "artifactSet": "sha256-394980afebd72fec5c840ed01a4fde134185a4b79e17b23ba044b03deb388cc9",
          "approvalRequired": []
        },
        {
          "request": {
            "source": "git:https://github.com/awebai/oats-okf.git@v2.1.1",
            "path": "oats-package"
          },
          "artifactSet": "sha256-32994916e1cdd8dd5f7d24ea3b91db872f74b5d6958c50c37dba82d606f507d4",
          "approvalRequired": []
        },
        {
          "request": {
            "source": "git:https://github.com/awebai/oats-aweb.git@v1.10.3",
            "path": "oats-package"
          },
          "artifactSet": "sha256-5fbf5303cd21ce34a754090fbcaa2411b3b48181d80b13ab78e174e05a709da4",
          "approvalRequired": []
        }
      ],
      "problems": [
        {
          "code": "needs-configuration",
          "message": "provider binding could not be prepared",
          "origins": []
        },
        {
          "code": "provider-not-qualified",
          "message": "selected provider has no matching binding interface",
          "origins": []
        }
      ]
    }
  }
}
```


**The equality is the fixture.** 2b and 3b are byte-identical after canonical JSON formatting; `diff` on the pretty-printed forms is empty. A regression test asserting they *differ* is the direct check for the attribution fix.


## 4a. trust --dir — prose mode (exit 1, stdout empty, this is stderr)

```text
$ oats trust oats.okf --dir /fixture/second-operator/deployment
oats: /fixture/second-operator/deployment/oats-lock.json: unsupported lockfileVersion 3
```


## 4b. trust --dir — JSON mode (exit 1)

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "invalid-lock",
    "message": "/fixture/second-operator/deployment/oats-lock.json: unsupported lockfileVersion 3"
  }
}
```


## 4c. the lock prepare wrote, that 4a/4b refuse (keys only)

```json
{
  "lockfileVersion": 3,
  "topLevelKeys": [
    "artifactSets",
    "lockfileVersion",
    "selections"
  ],
  "artifactSetIds": [
    "sha256-32994916e1cdd8dd5f7d24ea3b91db872f74b5d6958c50c37dba82d606f507d4",
    "sha256-394980afebd72fec5c840ed01a4fde134185a4b79e17b23ba044b03deb388cc9",
    "sha256-5fbf5303cd21ce34a754090fbcaa2411b3b48181d80b13ab78e174e05a709da4"
  ]
}
```


## Two things to carry into the fixtures

The **seam-2 ENOENT** is not captured above because I had already created the deployment directory by then. It reproduces cleanly: run `prepare --request` with any `deployment` path that does not exist, and note that `inspect` on that same path returns `state: "absent"` with `status: "ready"`. Worth a fixture of its own, since the two commands disagreeing about an absent path is the actual defect.

The **seam-1 workTarget** rejection reproduces by feeding `inspect`'s request file (1a) straight to `prepare`: `invalid-declaration: unknown field at /workTarget`. If `prepare --request` learns to accept `workTarget`, 1a becomes a single request valid for both commands, which is the cleanest shape for the regression.

Deployment preserved as agreed. Ready to re-run the identical sequence on 0.24.2 and again on aweb 1.11.0 — the requests above are retained verbatim, so those will be true repeats rather than fresh attempts.