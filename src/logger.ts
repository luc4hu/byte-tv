import fs from 'node:fs';
import path from 'node:path';
import type { LogEntry, LogLevel } from './types';

const MAX_BUFFER = 2000;
const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024;
const ringBuffer: LogEntry[] = [];
let writeStream: fs.WriteStream | null = null;
let subscribers: Array<(entry: LogEntry) => void> = [];

function formatTimestamp(): string {
  return new Date().toISOString().slice(0, 19) + 'Z';
}

function serializeArg(arg: unknown): string {
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`;
  }
  return String(arg);
}

function formatMessage(...args: unknown[]): string {
  return args.map(serializeArg).join(' ');
}

function stripNewlines(s: string): string {
  return s.replace(/\n/g, '\\n').replace(/\r/g, '');
}

function writeEntry(entry: LogEntry) {
  // In-memory ring buffer
  ringBuffer.push(entry);
  if (ringBuffer.length > MAX_BUFFER) {
    ringBuffer.shift();
  }

  // File write (async, not awaited)
  const line = `${entry.ts} [${entry.level}] ${entry.message}\n`;
  if (writeStream) {
    writeStream.write(line);
  }

  // Forward to terminal with colour hint via level
  const terminalLine = `${entry.ts} [${entry.level}] ${entry.message.replace(/\\n/g, '\n')}`;
  if (entry.level === 'error') {
    console.error(terminalLine);
  } else if (entry.level === 'warn') {
    console.warn(terminalLine);
  } else {
    console.log(terminalLine);
  }

  // Notify live subscribers
  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {
      // subscriber must not break the logger
    }
  }
}

export function initLogger(logDir: string): void {
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logPath = path.join(logDir, 'byte-tv.log');

    // Rotate at startup so the log file doesn't grow unbounded
    try {
      if (fs.statSync(logPath).size > MAX_LOG_FILE_SIZE) {
        fs.renameSync(logPath, `${logPath}.1`);
      }
    } catch {
      // no existing log file
    }

    writeStream = fs.createWriteStream(logPath, { flags: 'a' });

    const entry: LogEntry = {
      ts: formatTimestamp(),
      level: 'info',
      message: `[startup] log file at ${logPath}`,
    };
    writeEntry(entry);
  } catch (err) {
    console.error('[logger] failed to initialise log file:', err);
  }
}

export function log(level: LogLevel, ...args: unknown[]): void {
  const message = stripNewlines(formatMessage(...args));
  const entry: LogEntry = {
    ts: formatTimestamp(),
    level,
    message,
  };
  writeEntry(entry);
}

/** Convenience helpers */
export const logInfo = (...args: unknown[]) => log('info', ...args);
export const logWarn = (...args: unknown[]) => log('warn', ...args);
export const logError = (...args: unknown[]) => log('error', ...args);
export const logDebug = (...args: unknown[]) => log('debug', ...args);

export function getLogs(): LogEntry[] {
  return [...ringBuffer];
}

export function clearLogs(): void {
  ringBuffer.length = 0;
}

export function subscribeLogs(fn: (entry: LogEntry) => void): () => void {
  subscribers.push(fn);
  return () => {
    subscribers = subscribers.filter(s => s !== fn);
  };
}
