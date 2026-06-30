import { existsSync, mkdirSync, renameSync, statSync, createWriteStream } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import * as telegram from './telegram/telegram.js';
import * as api from './api/api.js';
import * as watchdog from './core/watchdog.js';
import * as orchestrator from './orchestrator/orchestrator.js';
import * as github from './github/github.js';
import * as githubWriteQueue from './github/github-write-queue.js';
import * as autoloop from './agents/autoloop.js';
import * as agents from './agents/agents.js';
import * as registry from './core/registry.js';
import { getRuntimeMode } from './runtime.js';
import { getDefaultModel, getOrchestratorModel, getDashboardConfig, getUsageConfig, getSchedulerConfig, getDaemonConfig } from './agents/fritz-config.js';
import * as usageMonitor from './agents/usage-monitor.js';
import { logEvent, trimOnStartup } from './core/event-log.js';
import * as scheduler from './core/scheduler.js';

console.log('');
console.log('╔═══════════════════════════════════════╗');
console.log('║        fritZ Orchestrator             ║');
console.log('╚═══════════════════════════════════════╝');
console.log('');
console.log('fritZ will handle all messages directly.');
console.log('');

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, shutting down...`);

  // Flush registry to disk immediately
  registry.flush();

  // Stop orchestrator
  orchestrator.stop();

  // Stop scheduler
  scheduler.stop();

  // Stop usage monitor
  usageMonitor.stop();

  // Stop auto-loop
  autoloop.stop();

  // Stop write queue (cancel pending operations)
  githubWriteQueue.shutdown();

  // Stop watchdog
  watchdog.stop();

  // Stop API server
  api.stop();

  // Stop Telegram bot
  telegram.stop();

  // Notify
  try {
    await telegram.sendMessage('🤖 *fritZ* stopped');
  } catch {
    // Ignore errors during shutdown
  }

  console.log('Goodbye! 👋');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Tee daemon stdout/stderr to a rotating log file
function setupDaemonLog(): void {
  try {
    const logsDir = join(config.workspacesDir, 'logs');
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }

    const logPath = join(logsDir, 'daemon.log');

    // Rotate if file exceeds 5 MB
    if (existsSync(logPath)) {
      const stat = statSync(logPath);
      if (stat.size > 5 * 1024 * 1024) {
        renameSync(logPath, logPath + '.old');
      }
    }

    const stream = createWriteStream(logPath, { flags: 'a' });

    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);

    (process.stdout as NodeJS.WriteStream).write = function(
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void
    ): boolean {
      try { stream.write(chunk); } catch { /* ignore */ }
      if (typeof encodingOrCb === 'function') {
        return origStdoutWrite(chunk as string, encodingOrCb);
      }
      return origStdoutWrite(chunk as string, encodingOrCb as BufferEncoding, cb);
    } as typeof process.stdout.write;

    (process.stderr as NodeJS.WriteStream).write = function(
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void
    ): boolean {
      try { stream.write(chunk); } catch { /* ignore */ }
      if (typeof encodingOrCb === 'function') {
        return origStderrWrite(chunk as string, encodingOrCb);
      }
      return origStderrWrite(chunk as string, encodingOrCb as BufferEncoding, cb);
    } as typeof process.stderr.write;
  } catch {
    // Non-fatal — if log setup fails, daemon still works
  }
}

// Main
async function main(): Promise<void> {
  try {
    // Tee daemon output to {workspacesDir}/logs/daemon.log
    setupDaemonLog();

    // Trim event log on startup (keep last 500 entries)
    trimOnStartup();

    // Step 1: Check config
    console.log('[1/11] Checking configuration...');

    const missingConfig: string[] = [];
    if (!config.telegramBotToken) missingConfig.push('TELEGRAM_BOT_TOKEN');
    if (!config.telegramChatId) missingConfig.push('TELEGRAM_CHAT_ID');

    if (missingConfig.length > 0) {
      console.error(`     Missing: ${missingConfig.join(', ')}`);
      console.error('     Set these in .env or environment');
      process.exit(1);
    }
    console.log(`     GitHub repo: ${config.githubRepo || '(not set)'}`);
    const orchModel = getOrchestratorModel();
    const defaultModel = getDefaultModel();
    console.log(`     🤖 Orchestrator model: ${orchModel} (from fritz.yaml)`);
    if (defaultModel !== orchModel) {
      console.log(`     🤖 Default agent model: ${defaultModel} (from fritz.yaml)`);
    }
    console.log(`     🐳 Orchestrator runtime: ${getRuntimeMode()}`);
    console.log(`     📦 Agents: Always Docker containers`);

    // Show authentication method
    if (config.claudeOauthToken) {
      console.log(`     🔑 Auth: OAuth token (CLAUDE_CODE_OAUTH_TOKEN)`);
    } else if (config.anthropicApiKey) {
      console.log(`     🔑 Auth: API key configured`);
    } else {
      console.log(`     🔑 Auth: File-based (via ~/.claude mount)`);
    }

    // Step 2: Initialize registry (load from disk into in-memory cache)
    console.log('[2/11] Initializing registry...');
    registry.init();

    // Step 3: Clean up orphan agents from previous daemon instance
    console.log('[3/11] Cleaning up orphan agents...');
    await agents.cleanupOrphanAgents();

    // Step 4: Setup GitHub labels
    console.log('[4/11] Setting up GitHub labels...');
    if (config.githubRepo) {
      try {
        await github.ensureLabels();
        console.log('     Labels ready (fritz.skill:*, fritz.status:*)');
      } catch {
        console.log('     Warning: Could not setup labels (check GH_TOKEN)');
      }
    } else {
      console.log('     Skipped (no GITHUB_REPO configured)');
    }

    // Step 4b: Start GitHub write queue
    const daemonCfg = getDaemonConfig();
    if (!daemonCfg.writeQueueEnabled) {
      githubWriteQueue.setEnabled(false);
      console.log('     Write queue disabled via fritz.yaml');
    }
    githubWriteQueue.start();

    // Step 5: Start Telegram bot
    console.log('[5/11] Connecting to Telegram...');
    await telegram.start();

    // Step 6: Start API server (message broker for agents)
    console.log('[6/11] Starting API server...');
    await api.start();
    console.log(`     Listening on port ${config.apiPort}`);
    console.log(`     Daemon URL for agents: ${config.daemonUrl}`);
    if (getDashboardConfig().enabled) {
      console.log(`     📊 Dashboard: http://localhost:${config.apiPort}/dashboard`);
    }

    // Step 7: Start watchdog
    console.log('[7/11] Starting watchdog...');
    watchdog.start({ quiet: true });

    // Step 8: Start fritZ orchestrator
    console.log('[8/11] Starting fritZ orchestrator (Claude Code)...');
    await orchestrator.start();

    // Step 9: Start auto-orchestration loop
    console.log('[9/11] Starting auto-orchestration loop...');
    autoloop.start({ quiet: true });
    if (config.githubRepo) {
      console.log('     Watching: for-define, for-implement, for-review, for-validate, for-rework, discussion');
    } else {
      console.log('     Disabled (no GITHUB_REPO)');
    }

    // Step 10: Start usage monitor
    console.log('[10/11] Starting usage monitor...');
    usageMonitor.start();
    const usageCfg = getUsageConfig();
    if (usageCfg.enabled) {
      console.log(`     Pause at ${usageCfg.pauseThreshold}%, resume at ${usageCfg.resumeThreshold}%, check every ${usageCfg.checkIntervalMinutes}min`);
    } else {
      console.log('     Disabled (usage.enabled: false)');
    }

    // Step 11: Start scheduler
    console.log('[11/11] Starting scheduler...');
    scheduler.start({ quiet: true });
    const schedulerCfg = getSchedulerConfig();
    if (schedulerCfg.enabled) {
      const jobCount = schedulerCfg.jobs.filter(j => j.enabled).length;
      console.log(`     ${jobCount} job(s) configured, check every ${schedulerCfg.checkIntervalSec}s`);
    } else {
      console.log('     Disabled (scheduler.enabled: false)');
    }

    // Ready!
    console.log('');
    console.log('───────────────────────────────────────');
    console.log('✅ Ready!');
    console.log('───────────────────────────────────────');
    console.log('');
    console.log('fritZ is listening.');
    console.log('All "fritz ..." messages go directly to Claude Code.');
    console.log('');
    console.log('Try: "fritz hallo, wer bist du?"');
    console.log('');
    console.log('Press Ctrl+C to stop');
    console.log('');

    // Log daemon start event (after all subsystems are up)
    logEvent('daemon.started', 'Daemon started');
  } catch (error) {
    console.error('');
    console.error('Failed to start:', error);
    process.exit(1);
  }
}

main();
