# Third-party notices

In OATS's copy, the template's `capabilities/<name>/` is `capabilities/oats-<name>/`: its
`capabilities/build/` is `capabilities/oats-build/` here.

Three rules of the build skill for the repository (`oats.build`) and the quality floor in the
developer's and the expert's briefings adapt rules from MIT-licensed skill collections. The
rules were rewritten in this template's words; no file was copied. Each source's copyright
notice and licence follow, as the MIT licence asks. Keep this file with any copy of those
texts (ADAPTING.md, section 1).

| Template text | Adapted from |
|---|---|
| `capabilities/build/skills/build-in-the-repository`, section 3: three failed fixes means stop | mattpocock/skills (`diagnosing-bugs`); obra/superpowers (`systematic-debugging`) |
| `capabilities/build/skills/build-in-the-repository`, section 3: a rename, a move or an extraction in a commit of its own | mattpocock/skills (`codebase-design`); addyosmani/agent-skills (`api-and-interface-design`, `incremental-implementation`) |
| `capabilities/build/skills/build-in-the-repository`, section 3: no test asserts on a double; doubles only at real boundaries | mattpocock/skills (`tdd`); obra/superpowers (`test-driven-development`) |
| `capabilities/build/skills/build-in-the-repository`, section 4: every claim names its evidence | obra/superpowers (`verification-before-completion`) |
| `capabilities/developer/injects/developer.md` and `capabilities/engineering-expert/injects/expert.md`, the quality floor | addyosmani/agent-skills (`constraint-driven-development`) |

template-v3.1.3 and earlier carried four longer build skills adapted from the same sources
(`test-first`, `diagnose-before-fixing`, `design-while-writing`, `prove-it-works`); a copy
that keeps them keeps this file's earlier table with them.

## mattpocock/skills

https://github.com/mattpocock/skills, read at commit `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`.

```
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## obra/superpowers

https://github.com/obra/superpowers, read at commit `22f0b463e7a5e579904dd6211a520321035526f7`.

```
MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## addyosmani/agent-skills

https://github.com/addyosmani/agent-skills, read at commit `301b02b12bff98e4688e6984af6556802322bbde`.

```
MIT License

Copyright (c) 2025 Addy Osmani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
