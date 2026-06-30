import { existsSync, readFileSync } from 'fs';

/**
 * Detect if the code is running inside a Docker container.
 *
 * Checks multiple indicators:
 * 1. /.dockerenv file (created by Docker)
 * 2. "docker" or "containerd" in /proc/1/cgroup
 * 3. FRITZ_RUNTIME_MODE environment variable override
 */
export function isRunningInDocker(): boolean {
  // Allow explicit override via environment variable
  const runtimeMode = process.env.FRITZ_RUNTIME_MODE;
  if (runtimeMode === 'docker') return true;
  if (runtimeMode === 'native') return false;

  // Check for /.dockerenv file
  if (existsSync('/.dockerenv')) {
    return true;
  }

  // Check /proc/1/cgroup for docker/containerd
  try {
    if (existsSync('/proc/1/cgroup')) {
      const cgroup = readFileSync('/proc/1/cgroup', 'utf-8');
      if (cgroup.includes('docker') || cgroup.includes('containerd')) {
        return true;
      }
    }
  } catch {
    // If we can't read /proc/1/cgroup, assume not in Docker
  }

  return false;
}

/**
 * Get the runtime mode as a string for logging
 */
export function getRuntimeMode(): 'docker' | 'native' {
  return isRunningInDocker() ? 'docker' : 'native';
}
