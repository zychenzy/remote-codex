import fs from "node:fs";
import path from "node:path";

const SECRET_PATTERNS = [
  /(?:bot|token|secret|api[_-]?key)\s*[:=]\s*([A-Za-z0-9_:\-\.]{8,})/gi,
  /Bearer\s+([A-Za-z0-9\-_.]{8,})/gi,
];

function maskValue(value) {
  const str = String(value);
  if (str.length <= 5) {
    return "***";
  }
  return `${str.slice(0, 3)}***${str.slice(-2)}`;
}

function redact(text, secrets = []) {
  let output = String(text || "");
  // ponytail: value-based redaction of known secrets.
  // Pattern-based redaction only catches label-adjacent tokens (e.g. `token: abc`);
  // string-replace the known secret values so they are masked even when logged bare.
  for (const secret of secrets) {
    if (!secret) {
      continue;
    }
    const value = String(secret);
    if (value.length < 4) {
      continue;
    }
    output = output.split(value).join(maskValue(value));
  }
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (full, token) => full.replace(token, maskValue(token)));
  }
  return output;
}

export function createLogger({ filePath, level = "info", secrets = [] } = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // ignore: best-effort tightening of the logs directory permissions
  }

  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const threshold = levels[level] ?? levels.info;
  const secretList = Array.isArray(secrets) ? secrets.filter(Boolean) : [secrets].filter(Boolean);

  let stream = null;
  function getStream() {
    if (!stream) {
      stream = fs.createWriteStream(filePath, { flags: "a", mode: 0o600 });
    }
    return stream;
  }

  function write(kind, args) {
    if ((levels[kind] ?? 2) > threshold) {
      return;
    }
    const message = redact(
      args.map((item) => (item instanceof Error ? item.stack || item.message : String(item))).join(" "),
      secretList
    );
    const line = `${new Date().toISOString()} [${kind.toUpperCase()}] ${message}`;
    getStream().write(`${line}\n`);
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
