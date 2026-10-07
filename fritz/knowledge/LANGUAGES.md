# Language Support

machina supports multiple programming languages through specialized agent Docker images. Each image includes the necessary compilers, build tools, and runtimes.

_Part of the machina [knowledge base](README.md) — read by every agent at boot._

## Available Images

| Image | Languages | Key Tools | Base |
|-------|-----------|-----------|------|
| `fritz-agent` (default) | JavaScript, TypeScript | Node.js 20, npm | `node:20-slim` |
| `fritz-agent-java` | Java, Kotlin, Scala | OpenJDK 21, Maven, Gradle 8.12 | `fritz-agent` |
| `fritz-agent-cpp` | C, C++ | gcc, g++, cmake, ninja, gdb | `fritz-agent` |
| `fritz-agent-rust` | Rust | rustup stable, cargo, rustfmt, clippy, protoc | `fritz-agent` |
| `fritz-agent-kali` | Security testing | nmap, nuclei, sqlmap, hydra, ffuf, etc. | `kalilinux/kali-rolling` |

Variant images (`fritz-agent-java`, `fritz-agent-cpp`, `fritz-agent-rust`) extend from `fritz-agent` and inherit Claude Code CLI, GitHub CLI, git, curl, jq, `WORKDIR /workspace`, and `ENTRYPOINT ["claude"]`. They only add language-specific toolchains.

**Exception:** `fritz-agent-kali` uses `kalilinux/kali-rolling` as its base (not `fritz-agent`) because Kali tools require Kali's APT repositories. It reinstalls the machina agent prerequisites (Node.js, Claude Code, gh CLI) independently.

## How Image Selection Works

The daemon automatically selects the right image based on **GitHub issue labels**:

| Label | Image Selected |
|-------|---------------|
| `fritz.lang:java` | `fritz-agent-java` |
| `fritz.lang:cpp` | `fritz-agent-cpp` |
| `fritz.lang:rust` | `fritz-agent-rust` |
| `fritz.lang:kali` | `fritz-agent-kali` |
| _(no label)_ | `fritz-agent` (default) |

To use a specific image, add the appropriate `fritz.lang:` label to the GitHub issue before booting an agent.

## Building Images

**Single image:**
```bash
# From fritz-orchestrator/ directory
docker build -t fritz-agent -f Dockerfile.agent .
docker build -t fritz-agent-java -f Dockerfile.agent.java .
docker build -t fritz-agent-cpp -f Dockerfile.agent.cpp .
docker build -t fritz-agent-rust -f Dockerfile.agent.rust .
docker build -t fritz-agent-kali -f Dockerfile.agent.kali .
```

**Via docker-compose (dev):**
```bash
docker-compose --profile build build fritz-agent
docker-compose --profile build build fritz-agent-java
docker-compose --profile build build fritz-agent-cpp
docker-compose --profile build build fritz-agent-rust
docker-compose --profile build build fritz-agent-kali
```

## Java Environment Details

- **JDK:** OpenJDK 21 (LTS, supported until 2031)
- **Build tools:** Maven (with `MAVEN_OPTS` pre-configured), Gradle 8.12
- **JAVA_HOME:** `/usr/lib/jvm/java-21-openjdk` (architecture-independent symlink)
- **GRADLE_HOME:** `/opt/gradle/gradle-8.12`
- **Maven cache:** `/home/node/.m2/repository`
- **Gradle cache:** `/home/node/.gradle`

## C/C++ Environment Details

- **Compilers:** gcc/g++ (from `build-essential`)
- **Build systems:** cmake, ninja-build, make
- **Debugger:** gdb
- **Libraries:** zlib, OpenSSL (headers + dev packages)
- **pkg-config** for library discovery
- **Parallel builds:** `MAKEFLAGS=-j6` and `CMAKE_BUILD_PARALLEL_LEVEL=6` are set by default for faster compilation

## Rust Environment Details

- **Toolchain:** `rustup` with stable (default), installed per-user at `/home/node/.rustup`
- **Components:** `rustfmt`, `clippy` (both pre-installed via `rustup component add`)
- **Cargo home:** `/home/node/.cargo` (PATH includes `/home/node/.cargo/bin`)
- **System deps:** `build-essential`, `pkg-config`, `libssl-dev`, `protobuf-compiler` (for gRPC/prost builds)
- **Formatter / linter** (respect the project's `rustfmt.toml`):
  - Auto-fix: `cargo fmt --all`
  - Verify: `cargo fmt --all -- --check` (must exit 0 before PR)
  - Lint: `cargo clippy --all-targets -- -D warnings`

## Formatting & Linting — Quick Reference

machina agents are **required to run the formatter and linter before every commit** and verify they pass before opening a PR. CI format failures are the #1 cause of auto-merge being escalated to a human. See [`implement` skill → Format and Lint](../skills/implement/SKILL.md) for the full policy.

| Language / Ecosystem | Auto-fix | CI-equivalent verify | Linter |
|---|---|---|---|
| Rust | `cargo fmt --all` | `cargo fmt --all -- --check` | `cargo clippy --all-targets -- -D warnings` |
| TypeScript / JavaScript | `npx prettier --write .` / `npm run format` | `npx prettier --check .` | `npx eslint .` / `npm run lint` |
| Python | `ruff format .` | `ruff format --check .` | `ruff check .` |
| Go | `gofmt -w .` | `test -z "$(gofmt -l .)"` | `go vet ./...` |
| Java / Kotlin (Gradle) | `./gradlew spotlessApply` | `./gradlew spotlessCheck` | `./gradlew check` |
| C / C++ | `clang-format -i <files>` | `clang-format --dry-run --Werror <files>` | project-specific |

**Rules:**
- Always prefer the command the project's CI actually runs — check `.github/workflows/`, `Makefile`, `package.json` scripts first.
- Respect project config (`rustfmt.toml`, `.prettierrc`, `pyproject.toml`, `.editorconfig`, etc.) — never override.
- If the formatter produces changes, commit them. Never hand-edit to skirt the formatter.
- If the expected tool is missing from the agent image, `report.sh blocked` — do not skip.

## Kali Linux Environment Details

- **Base image:** `kalilinux/kali-rolling` (standalone, not derived from `fritz-agent`)
- **Install strategy:** individual tool packages only — the `kali-tools-*` metapackages are deliberately **not** installed (they pull 125+ tools and exceed the runner disk limit; see `Dockerfile.agent.kali`)
- **Image size:** ~3-6 GB (larger due to security tool suite)
- **CI job:** Independent `build-kali-agent` job (runs in parallel, no dependency on base image build)

<details>
<summary>Installed tools (13 security tools plus supporting utilities)</summary>

Security tools: `nmap`, `gobuster`, `nuclei`, `ffuf`, `nikto`, `wfuzz`, `sqlmap`, `hydra`, `amass`, `netexec`, `enum4linux-ng`, `searchsploit` (from the `exploitdb` package), `testssl.sh`.

Supporting utilities: `dnsutils`, `whois`, and `paramspider` (installed from GitHub).

</details>

> [!CAUTION]
> The `fritz.lang:kali` label grants agents offensive security tooling (`nmap`, `nuclei`, `sqlmap`, `hydra`, `netexec`, and more) — a meaningful capability escalation over other variants. Apply it only to issues from trusted collaborators with authorized security-testing context (penetration-testing engagements, CTF competitions, security research). Administrators should restrict who can apply `fritz.lang:` labels via GitHub branch protection rules or CODEOWNERS.

---

_See also: [LABELS.md](LABELS.md) (the `fritz.lang:` label reference), [ARCHITECTURE.md](ARCHITECTURE.md) (agent containers), and the [root README](../../README.md)._
