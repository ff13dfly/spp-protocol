# String Particle Protocol (SPP)

SPP is a minimal semantic space protocol designed for AI-native 3D world generation, optimization, and long-term evolution.

Instead of describing geometry directly, SPP represents space as a set of discrete cells with face-level connection options.
The final 3D structure emerges through a collapse process that resolves these possibilities into a consistent spatial configuration.

SPP is designed to:

- Enable AI-driven world generation
- Separate spatial logic from visual representation
- Support long-term compatibility across devices and eras

## Specification

| Document | Description | Status |
| -------- | ----------- | ------ |
| [SPP-Core v1.0](./specs/SPP-Core-v1.0.md) | Core semantic data model | Stable |

## Repository Layout

```
├─ specs/          ← Protocol specifications
├─ spp-examples/   ← Example worlds
├─ spp-reference/  ← Reference implementations
└─ spp-tools/      ← Toolchain
```

## License

Copyright (c) 2026 傅忠强 (Zhongqiang Fu).
Licensed under [CC BY-NC 4.0](./LICENSE) — free for non-commercial use; commercial use requires authorization.