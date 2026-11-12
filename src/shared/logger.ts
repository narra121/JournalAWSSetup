interface LogBase {
  level: string;
  msg: string;
  time: string;
  requestId?: string;
  userId?: string;
  [key: string]: any;
}

const ORDER = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

/** LOG_LEVEL (debug|info|warn|error, default info) drops lower levels. */
function enabled(level: string): boolean {
  const min = ORDER.indexOf((process.env.LOG_LEVEL || 'info').toUpperCase());
  return ORDER.indexOf(level) >= (min === -1 ? 1 : min);
}

function emit(obj: LogBase) {
  if (enabled(obj.level)) console.log(JSON.stringify(obj));
}

export function makeLogger(ctx?: { requestId?: string; userId?: string }) {
  const base = { requestId: ctx?.requestId, userId: ctx?.userId };
  return {
    debug: (msg: string, extra?: any) => emit({ level: 'DEBUG', msg, time: new Date().toISOString(), ...base, ...extra }),
    info: (msg: string, extra?: any) => emit({ level: 'INFO', msg, time: new Date().toISOString(), ...base, ...extra }),
    warn: (msg: string, extra?: any) => emit({ level: 'WARN', msg, time: new Date().toISOString(), ...base, ...extra }),
    error: (msg: string, extra?: any) => emit({ level: 'ERROR', msg, time: new Date().toISOString(), ...base, ...extra })
  };
}

export type Logger = ReturnType<typeof makeLogger>;