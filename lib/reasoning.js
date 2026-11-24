const OPEN_TAG = "<think>\n";
const CLOSE_TAG = "\n</think>\n\n";

function transformCompletion(data, mode) {
  if (mode === "passthrough" || !data || !Array.isArray(data.choices)) return data;
  for (const choice of data.choices) {
    const message = choice.message;
    if (!message || message.reasoning_content === undefined) continue;
    if (mode === "show" && message.reasoning_content) {
      message.content = OPEN_TAG + message.reasoning_content + CLOSE_TAG + (message.content || "");
    }
    delete message.reasoning_content;
  }
  return data;
}

class SseRewriter {
  constructor(mode) {
    this.mode = mode;
    this.buffer = "";
    this.reasoningOpen = false;
  }

  feed(text) {
    this.buffer += text;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop();
    let output = "";
    for (const line of lines) output += this.rewriteLine(line);
    return output;
  }

  flush() {
    const remainder = this.buffer;
    this.buffer = "";
    return remainder;
  }

  rewriteLine(line) {
    if (this.mode === "passthrough" || !line.startsWith("data: ")) return line + "\n";
    const payload = line.slice(6).trim();
    if (payload === "" || payload === "[DONE]") return line + "\n";

    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return line + "\n";
    }

    const delta = json.choices && json.choices[0] && json.choices[0].delta;
    if (!delta) return line + "\n";

    if (delta.reasoning_content !== undefined) {
      if (this.mode === "show") {
        let text = delta.reasoning_content || "";
        if (!this.reasoningOpen && text) {
          text = OPEN_TAG + text;
          this.reasoningOpen = true;
        }
        delta.content = text;
      } else {
        delta.content = "";
      }
      delete delta.reasoning_content;
    } else if (this.reasoningOpen && typeof delta.content === "string" && delta.content) {
      delta.content = CLOSE_TAG + delta.content;
      this.reasoningOpen = false;
    }

    return "data: " + JSON.stringify(json) + "\n";
  }
}

module.exports = { transformCompletion, SseRewriter };
