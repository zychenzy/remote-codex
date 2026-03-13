import fs from "node:fs";
import path from "node:path";

const SECRET_PATTERNS = [
  /(?:bot|token|secret|api[_-]?key)\s*[:=]\s*([A-Za-z0-9_:\-\.]{8,})/gi,
  /Bearer\s+([A-Za-z0-9\-_.]{8,})/gi,
];

function redact(text) {
  let output = String(text || "");
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (full, token) => full.replace(token, `${token.slice(0, 3)}***${token.slice(-2)}`));
  }
  return output;
}

export function createLogger({ filePath, level = "info" } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const threshold = levels[level] ?? levels.info;

  function write(kind, args) {
    if ((levels[kind] ?? 2) > threshold) {
      return;
    }
    const message = redact(args.map((item) => (item instanceof Error ? item.stack || item.message : String(item))).join(" "));
    const line = `${new Date().toISOString()} [${kind.toUpperCase()}] ${message}`;
    fs.appendFileSync(filePath, `${line}\n`);
    if (kind === "error") {
      console.error(line);
    }
  }

  return {
    error: (...args) => write("error", args),
    warn: (...args) => write("warn", args),
    info: (...args) => write("info", args),
    debug: (...args) => write("debug", args),
  };
}
