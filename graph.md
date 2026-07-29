
> playtest-monorepo@0.1.0 codebase:graph
> node tools/codebase-map/index.mjs graph

flowchart LR
  m0["@playtest/cli"]
  m1["@playtest/control-plane"]
  m2["@playtest/core"]
  m3["@playtest/run-viewer"]
  m4["@playtest/runner-agent"]
  m5["@playtest/web"]
  m6["examples/ledger-api"]
  m7["examples/ledger-api/bench"]
  m8["examples/ledger-api/src"]
  m9["examples/ledger-api/test"]
  m10["studies/api-suite"]
  m11["studies/hosted-ux"]
  m12["tests/fixtures"]
  m13["tests/repository"]
  m14["tests/support"]
  m15["tools/perf"]
  m16["tools/ux-lab"]
  m0 -->|19 imports| m2
  m0 --> m3
  m0 -->|2 imports| m14
  m1 -->|36 imports| m2
  m1 -->|3 imports| m5
  m1 -->|2 imports| m12
  m1 -->|7 imports| m14
  m2 -->|16 imports| m12
  m2 -->|28 imports| m14
  m3 -->|12 imports| m2
  m3 -->|4 imports| m14
  m4 -->|11 imports| m2
  m4 --> m12
  m5 -->|2 imports| m2
  m5 --> m3
  m6 -->|3 imports| m8
  m7 -->|3 imports| m8
  m9 -->|15 imports| m7
  m9 -->|11 imports| m8
  m10 -->|5 imports| m2
  m11 -->|3 imports| m1
  m11 --> m2
  m13 -->|3 imports| m2
  m15 -->|3 imports| m2
  m15 -->|2 imports| m12
  m16 -->|3 imports| m1
  m16 --> m2
