# Principles

Core principles that guide how we approach problems.

## Problem-Solving Approach

Before implementing, ask yourself:

1. **What is the actual problem?** (one sentence, not a solution)
2. **Who should solve it?** (user, agent, daemon, infrastructure?)
3. **What's the simplest thing that works?** (one line? one file? zero code?)
4. **Am I adding complexity because it's needed, or because it feels robust?**
5. **Does this already exist?** Search the codebase before writing new code. If similar functionality exists, extend it instead of duplicating.

If your first solution is more than ~50 lines, stop and reconsider. The best solution is often the one that requires the least new code.

**Example:** "Agent doesn't know what tools are in its container" → Don't build a manifest system. Just tell the agent to run `node --version`, `java --version`, etc.
