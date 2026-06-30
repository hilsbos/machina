/**
 * Pure utility functions for diagnosis — hash computation, directory hashing,
 * and state comparison.
 *
 * Extracted from diagnose.ts so tests can import without triggering
 * side-effect dependencies (config, registry, watchdog).
 */

import { createHash } from 'crypto';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, relative } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileHash {
  path: string;
  hash: string;
  size: number;
}

export interface DirectoryState {
  files: FileHash[];
  totalFiles: number;
  computedAt: string;
}

export interface DriftItem {
  path: string;
  localHash: string | null;
  remoteHash: string | null;
  type: 'modified' | 'added' | 'deleted';
}

// ---------------------------------------------------------------------------
// Git blob SHA-1 hash
// ---------------------------------------------------------------------------

/**
 * Compute git blob SHA-1 hash: sha1("blob {size}\0{content}")
 * This matches the hash format used by GitHub's tree API.
 */
export function gitBlobHash(content: Buffer): string {
  const header = `blob ${content.length}\0`;
  const store = Buffer.concat([Buffer.from(header), content]);
  return createHash('sha1').update(store).digest('hex');
}

// ---------------------------------------------------------------------------
// Local directory hashing
// ---------------------------------------------------------------------------

/** Recursively list all files in a directory. */
function listFiles(dir: string, base: string = dir): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full, base));
    } else if (entry.isFile()) {
      files.push(relative(base, full));
    }
  }
  return files.sort();
}

/** Hash all files in a directory using git blob format. */
export function hashDirectory(dirPath: string): DirectoryState {
  const filePaths = listFiles(dirPath);
  const files: FileHash[] = filePaths.map((relPath) => {
    const fullPath = join(dirPath, relPath);
    const content = readFileSync(fullPath);
    return {
      path: relPath,
      hash: gitBlobHash(content),
      size: content.length,
    };
  });

  return {
    files,
    totalFiles: files.length,
    computedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** Compare local vs remote states and return drift items. */
export function compareStates(
  local: DirectoryState,
  remote: DirectoryState
): DriftItem[] {
  const drift: DriftItem[] = [];
  const localMap = new Map(local.files.map((f) => [f.path, f.hash]));
  const remoteMap = new Map(remote.files.map((f) => [f.path, f.hash]));

  // Modified or deleted remotely (exists local, differs or missing remote)
  for (const [path, localHash] of localMap) {
    const remoteHash = remoteMap.get(path);
    if (remoteHash === undefined) {
      drift.push({ path, localHash, remoteHash: null, type: 'deleted' });
    } else if (localHash !== remoteHash) {
      drift.push({ path, localHash, remoteHash, type: 'modified' });
    }
  }

  // Added remotely (exists remote, missing local)
  for (const [path, remoteHash] of remoteMap) {
    if (!localMap.has(path)) {
      drift.push({ path, localHash: null, remoteHash, type: 'added' });
    }
  }

  return drift;
}
