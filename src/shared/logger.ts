type Fields = Record<string, unknown>;

function log(level: "info" | "warn" | "error", msg: string, fields?: Fields): void {
  const line = { level, msg, time: new Date().toISOString(), ...fields };
  const out = level === "error" ? console.error : console.log;
  out(JSON.stringify(line));
}

export const logger = {
  info: (msg: string, fields?: Fields) => log("info", msg, fields),
  warn: (msg: string, fields?: Fields) => log("warn", msg, fields),
  error: (msg: string, fields?: Fields) => log("error", msg, fields),
};
