# Skill Modes: Orchestrated vs Standalone

Sub-skills (architect, ux, budget) can run in two modes, determined automatically by checking GitHub labels.

## Mode Detection

At startup, skills check for the `fritz.skill:define` label:

```bash
ISSUE_LABELS=$(gh issue view $ISSUE_NUMBER --json labels -q '.labels[].name' 2>/dev/null)

# Fail-safe: Default to orchestrated mode if labels are empty or detection fails
if [ -n "$ISSUE_LABELS" ] && ! echo "$ISSUE_LABELS" | grep -q "fritz.skill:define"; then
  MODE="standalone"
else
  MODE="orchestrated"  # Default on failure (safer)
fi
```

## Orchestrated Mode

**Trigger**: `fritz.skill:define` label present (skill invoked by `/define`)

**Behavior**:
- Post summary as GitHub comment
- Reference spec by file path
- `/define` synthesizes all outputs into the issue body

**Output example**:
```
## 🏗️ Tech Spec Complete
**Approach**: [One-line summary]
Full spec: `fritz/specs/[feature]/TECH_SPEC.md` on the feature branch
```

## Standalone Mode

**Trigger**: `fritz.skill:define` label absent (skill invoked directly via `for-architect`, `for-ux`, or `for-budget`)

**Behavior**:
- Update issue body directly
- Include inline summaries
- Add clickable GitHub URLs to spec files

**Output example**:
```
# Technical Specification: [Feature Name]

## Overview
> [2-3 sentence summary]

[📄 View full Technical Spec](https://github.com/owner/repo/blob/branch/fritz/specs/.../TECH_SPEC.md)
```

## Fail-Safe Behavior

If label detection fails (e.g., `gh issue view` returns empty):
- **Default to orchestrated mode** (safer)
- This preserves backward compatibility
- Prevents unintended issue body overwrites

## Why This Design?

1. **No daemon changes needed** — Uses existing label infrastructure
2. **Reliable detection** — Labels set before agent starts
3. **Safe defaults** — Falls back to current behavior on failure
4. **Clear semantics** — "Is `/define` involved?" maps directly to label presence
