type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: unknown;
}

/**
 * Logger en memoria con salida a consola.
 *
 * En Render los logs de stdout se capturan automaticamente, asi que no hace
 * falta un servicio externo. Los ultimos `maxLogs` se conservan en memoria
 * para poder consultarlos desde /health durante un diagnostico.
 */
class Logger {
  private logs: LogEntry[] = [];
  private maxLogs = 500;

  private write(level: LogLevel, message: string, data?: unknown): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) this.logs.shift();

    const colors: Record<LogLevel, string> = {
      info: '\x1b[36m',
      warn: '\x1b[33m',
      error: '\x1b[31m',
      debug: '\x1b[90m',
    };
    const reset = '\x1b[0m';

    const line = `${colors[level]}[${entry.timestamp}] ${level.toUpperCase()}: ${message}${reset}`;
    if (data !== undefined) console.log(line, data);
    else console.log(line);
  }

  info(message: string, data?: unknown): void {
    this.write('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.write('warn', message, data);
  }

  error(message: string, data?: unknown): void {
    this.write('error', message, data);
  }

  debug(message: string, data?: unknown): void {
    this.write('debug', message, data);
  }

  getLogs(level?: LogLevel): LogEntry[] {
    return level ? this.logs.filter(l => l.level === level) : [...this.logs];
  }

  clear(): void {
    this.logs = [];
  }
}

export const logger = new Logger();
