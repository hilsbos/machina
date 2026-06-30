import type { AgentRole } from '../types.js';
import { ROLE_EMOJI } from '../types.js';

// Message metadata for rich headers
export interface MessageMetadata {
  source: 'orchestrator' | 'agent';
  sourceId?: string; // e.g., "impl-7"
  role?: AgentRole;
  issue?: number;
  repo?: string;
  context?: string; // e.g., "sprint-3"
  timestamp: Date;
}

// Format a message with rich metadata header
export function formatMessage(
  body: string,
  metadata: MessageMetadata
): string[] {
  const header = buildHeader(metadata);
  const fullMessage = `${header}\n\n${body}`;

  // Handle Telegram 4096 char limit
  if (fullMessage.length <= 4096) {
    return [fullMessage];
  }

  // Split intelligently
  return splitMessage(fullMessage, 4096);
}

// Build the rich metadata header
function buildHeader(metadata: MessageMetadata): string {
  const emoji = getEmojiForSource(metadata);
  const sourceName = metadata.sourceId
    ? `${metadata.source}-${metadata.sourceId}`
    : metadata.source;

  if (metadata.source === 'orchestrator') {
    // Orchestrator header
    const context = metadata.context || '';
    const time = formatTime(metadata.timestamp);
    const contextTime = context ? `${context} • ${time}` : time;

    return `*${emoji} ${sourceName}*\n${contextTime}`;
  } else {
    // Agent header
    const issue = metadata.issue ? ` • #${metadata.issue}` : '';
    const repo = metadata.repo || '';
    const time = formatTime(metadata.timestamp);
    const repoTime = repo ? `${repo} • ${time}` : time;

    return `*${emoji} ${sourceName}${issue}*\n${repoTime}`;
  }
}

// Get emoji for source/role
function getEmojiForSource(metadata: MessageMetadata): string {
  if (metadata.source === 'orchestrator') {
    return '⚡';
  }

  if (metadata.role) {
    return ROLE_EMOJI[metadata.role] || '🤖';
  }

  return '🤖';
}

// Format timestamp (HH:MM, with date if not today)
function formatTime(timestamp: Date): string {
  const now = new Date();
  const isToday =
    timestamp.getDate() === now.getDate() &&
    timestamp.getMonth() === now.getMonth() &&
    timestamp.getFullYear() === now.getFullYear();

  const hours = timestamp.getHours().toString().padStart(2, '0');
  const minutes = timestamp.getMinutes().toString().padStart(2, '0');
  const time = `${hours}:${minutes}`;

  if (isToday) {
    return time;
  }

  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const month = months[timestamp.getMonth()];
  const day = timestamp.getDate();

  return `${month} ${day} ${time}`;
}

// Split message intelligently at paragraph breaks
function splitMessage(message: string, maxLength: number): string[] {
  // Find header end (header is 2 lines: bold line + info line, followed by blank line)
  const lines = message.split('\n');
  let headerEnd = -1;

  // Header format: *emoji source*\ninfo\n\nbody...
  // So header is first 2 lines if they match our pattern
  if (lines.length >= 2 && lines[0].startsWith('*') && lines[0].endsWith('*')) {
    // Find the blank line after header
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '') {
        headerEnd = message.indexOf('\n\n');
        break;
      }
    }
  }

  if (headerEnd === -1) {
    // No header, just split at paragraphs
    return simpleSplit(message, maxLength);
  }

  const header = message.slice(0, headerEnd);
  const body = message.slice(headerEnd + 2).trim(); // +2 for the \n\n

  // If body is empty or very short, return as single message
  if (body.length < 100) {
    return [message];
  }

  const chunks: string[] = [];
  const paragraphs = body.split('\n\n');
  let currentChunk = '';

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const testChunk =
      currentChunk === ''
        ? `${header}\n\n${para}`
        : `${currentChunk}\n\n${para}`;

    // Reserve space for chunk indicator
    if (testChunk.length + 20 > maxLength) {
      if (currentChunk === '') {
        // Single paragraph is too long, split it
        const splitPara = simpleSplit(para, maxLength - header.length - 50);
        for (const part of splitPara) {
          chunks.push(`${header}\n\n${part}`);
        }
      } else {
        chunks.push(currentChunk);
        currentChunk = para;
      }
    } else {
      currentChunk = testChunk;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  // Add chunk indicators if multiple chunks
  if (chunks.length > 1) {
    return chunks.map(
      (chunk, i) => `${chunk}\n\n(${i + 1}/${chunks.length})`
    );
  }

  return chunks;
}

// Simple split at word boundaries
function simpleSplit(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let currentChunk = '';
  const words = text.split(' ');

  for (const word of words) {
    if ((currentChunk + ' ' + word).length > maxLength - 20) {
      chunks.push(currentChunk.trim());
      currentChunk = word;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + word;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}
