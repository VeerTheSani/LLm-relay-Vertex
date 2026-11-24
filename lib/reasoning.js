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
    if (payload === "") return line + "\n";

    if (payload === "[DONE]") {
      if (this.mode === "show" && this.reasoningOpen) {
        this.reasoningOpen = false;
        const closingChunk = {
          id: `chatcmpl-close-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          choices: [
            {
              index: 0,
              delta: { content: CLOSE_TAG },
              finish_reason: null,
            },
          ],
        };
        return "data: " + JSON.stringify(closingChunk) + "\n\n" + line + "\n";
      }
      return line + "\n";
    }

    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return line + "\n";
    }

    const choice = json.choices && json.choices[0];
    const delta = choice && choice.delta;
    if (!delta) return line + "\n";

    const reasoningText = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
    const answerText = typeof delta.content === "string" ? delta.content : "";
    const hasReasoning = delta.reasoning_content !== undefined;

    if (hasReasoning) {
      delete delta.reasoning_content;
      if (this.mode === "show") {
        let out = "";
        if (reasoningText) {
          if (!this.reasoningOpen) {
            out += OPEN_TAG;
            this.reasoningOpen = true;
          }
          out += reasoningText;
        }
        if (answerText) {
          if (this.reasoningOpen) {
            out += CLOSE_TAG;
            this.reasoningOpen = false;
          }
          out += answerText;
        }
        delta.content = out;
      } else {
        delta.content = answerText;
      }
    } else if (this.reasoningOpen && answerText) {
      delta.content = CLOSE_TAG + answerText;
      this.reasoningOpen = false;
    }

    if (this.mode === "show" && this.reasoningOpen && choice.finish_reason) {
      delta.content = (typeof delta.content === "string" ? delta.content : "") + CLOSE_TAG;
      this.reasoningOpen = false;
    }

    return "data: " + JSON.stringify(json) + "\n";
  }
}

module.exports = { transformCompletion, SseRewriter };
