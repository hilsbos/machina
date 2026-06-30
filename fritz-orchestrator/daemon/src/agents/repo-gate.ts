/**
 * Repo helpers — pure functions for resolving target repos from labels.
 *
 * Used by autoloop.ts and other modules to resolve cross-repo issue targets.
 */

/** Strict owner/name pattern — rejects shell metacharacters and malformed values. */
const REPO_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

/**
 * Resolves the target repo for an issue from its labels.
 * Mirrors boot.ts normalization: null → defaultRepo.
 * Validates the result against a strict owner/name pattern to prevent injection.
 */
export function getTargetRepo(labels: string[], defaultRepo: string): string {
  const repoLabel = labels.find(l => l.startsWith('fritz.repo:'));
  if (repoLabel) {
    const repoValue = repoLabel.replace('fritz.repo:', '');
    // Strip branch suffix: fritz.repo:owner/name:branch → owner/name
    const repo = repoValue.includes(':') ? repoValue.split(':')[0] : repoValue;
    if (!REPO_PATTERN.test(repo)) {
      console.error(`[repo-gate] Invalid repo format in label "${repoLabel}" — falling back to default`);
      return defaultRepo;
    }
    return repo;
  }
  return defaultRepo;
}
