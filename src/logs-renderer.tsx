import { createRoot } from 'react-dom/client';
import { useState, useEffect, useRef, useCallback } from 'react';
import './logs-index.css';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
interface LogEntry {
  ts: string;
  level: LogLevel;
  message: string;
}

// The logs window has its own preload with a different API surface than the
// main window, so don't redeclare Window.electronAPI globally (it would
// conflict with the declaration in types.ts) — cast locally instead.
interface LogsAPI {
  getLogs: () => Promise<LogEntry[]>;
  clearLogs: () => Promise<void>;
  openLogsFolder: () => Promise<void>;
  onLogEntry: (callback: (entry: LogEntry) => void) => () => void;
  logFromRenderer: (level: LogLevel, message: string) => Promise<void>;
}

const api = (window as unknown as { electronAPI: LogsAPI }).electronAPI;

const ALL_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function LogsViewer() {
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(new Set(ALL_LEVELS));
  const [stickToBottom, setStickToBottom] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const filteredLines = lines.filter(l => activeLevels.has(l.level));

  // Scroll to bottom when new entries arrive if stick-to-bottom is enabled
  useEffect(() => {
    if (stickToBottom && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [filteredLines.length, stickToBottom]);

  // Detect manual scroll-up => pause autoscroll
  const handleScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setStickToBottom(atBottom);
  }, []);

  // Initial load + live tail
  useEffect(() => {
    api.getLogs().then(setLines);

    const unsub = api.onLogEntry((entry) => {
      setLines(prev => [...prev, entry].slice(-2000));
    });
    unsubRef.current = unsub;

    return () => {
      unsub();
      unsubRef.current = null;
    };
  }, []);

  const toggleLevel = (level: LogLevel) => {
    setActiveLevels(prev => {
      const next = new Set(prev);
      if (next.has(level)) {
        if (next.size === 1) return prev;
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  };

  const handleClear = async () => {
    await api.clearLogs();
    setLines([]);
  };

  const handleOpenFolder = () => {
    api.openLogsFolder();
  };

  return (
    <div className="logs-container">
      <div className="logs-header">
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Logs</h2>

        <div style={{ display: 'flex', gap: 4, marginLeft: 12 }}>
          {ALL_LEVELS.map(level => (
            <button
              key={level}
              className={`log-filter-chip${activeLevels.has(level) ? ' active' : ''}`}
              onClick={() => toggleLevel(level)}
            >
              {level.charAt(0).toUpperCase() + level.slice(1)}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <button className="logs-btn" onClick={handleClear}>Clear</button>
        <button className="logs-btn" onClick={handleOpenFolder}>Open Folder</button>
      </div>

      <div
        className="logs-body"
        ref={bodyRef}
        onScroll={handleScroll}
      >
        {filteredLines.length === 0 && (
          <div style={{ color: 'var(--text-muted)', padding: 24, textAlign: 'center', fontSize: 13 }}>
            No log entries match the current filter.
          </div>
        )}
        {filteredLines.map((entry, i) => (
          <div key={i} className={`log-line ${entry.level}`}>
            <span className="log-ts">[{entry.ts}]</span>
            {' '}
            <span className={`log-level-${entry.level}`}>[{entry.level}]</span>
            {' '}
            {entry.message}
          </div>
        ))}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<LogsViewer />);
