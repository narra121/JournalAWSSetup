interface LogBase {
  level: string;
  msg: string;
  time: string;
  requestId?: string;
  userId?: string;
  [key: string]: any;
}

function emit(obj: LogBase) {
  console.log(JSON.stringify(obj));
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