function extractTextParts(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part?.type === "text") {
        return part.text || "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function allUserTextFromTurn(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const texts = [];
  for (const item of items) {
    if (item?.type === "userMessage") {
      const fromContent = extractTextParts(item.content);
      if (fromContent) {
        texts.push(fromContent.trim());
        continue;
      }
      if (typeof item.text === "string" && item.text.trim()) {
        texts.push(item.text.trim());
      }
    }
  }
  return texts.filter(Boolean).join("\n\n");
}

export function allAgentTextFromTurn(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const texts = [];
  for (const item of items) {
    if (item?.type === "agentMessage" || item?.type === "plan") {
      if (typeof item.text === "string" && item.text.trim()) {
        texts.push(item.text.trim());
        continue;
      }
      const fromContent = extractTextParts(item.content);
      if (fromContent) {
        texts.push(fromContent.trim());
      }
    }
  }
  return texts.filter(Boolean).join("\n\n");
}
