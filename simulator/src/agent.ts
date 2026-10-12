// A simulated Alexa+ turn: the user's utterance goes to Claude together with
// the tools discovered from the Hearth MCP server; Claude decides which tools
// to call, we execute them over MCP, and loop until it has a spoken answer.
// Everything the UI needs (tool calls, MCP App cards, elicitation prompts,
// speech) is emitted as events.
import Anthropic from "@anthropic-ai/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, type Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

export type AgentEvent =
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; text: string; isError: boolean }
  | { type: "ui"; toolName: string; html: string; toolInput: unknown; toolResult: unknown }
  | { type: "say"; text: string }
  | { type: "error"; message: string };

const MODEL = process.env.HEARTH_MODEL ?? "claude-opus-5-5";
const UI_MIME = "text/html;profile=mcp-app";

const SYSTEM = `You are Alexa+, running on an Echo Show in a family home. You are speaking out loud.
Latency-sensitive; begin your visible answer immediately.
Reply in one to three short, warm, natural sentences. No markdown, lists, emoji or headings — this text is read aloud.
Each user message starts with a bracketed context line giving the local time and who is speaking. Use it to resolve "today", "tomorrow", "next Tuesday", and to know whether you're talking with the care recipient or a family member.
You have the Hearth caregiving tools. Use them rather than guessing about medications, appointments or how someone is doing. When a tool result suggests a next step (for example offering to alert family), offer it.
If a screen card is shown for a tool, say a short summary rather than reading every number.
Never give medical advice beyond what the family has recorded. If someone describes an emergency, tell them to call 911 first.`;

type Session = {
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
  mcpTools: Map<string, McpTool>;
};

export class AlexaSimulator {
  private anthropic = new Anthropic();
  private session: Session | null = null;

  private mcp: Client;

  constructor(mcp: Client) {
    this.mcp = mcp;
  }

  private async ensureSession(): Promise<Session> {
    if (this.session) return this.session;
    const { tools } = await this.mcp.listTools();
    this.session = {
      messages: [],
      mcpTools: new Map(tools.map((t) => [t.name, t])),
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? t.title ?? t.name,
        input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      })),
    };
    return this.session;
  }

  reset() {
    this.session = null;
  }

  async turn(utterance: string, speaker: string, emit: (e: AgentEvent) => void): Promise<void> {
    const s = await this.ensureSession();
    const now = new Date().toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
    const turnStart = s.messages.length;
    s.messages.push({ role: "user", content: `[${now} · speaker: ${speaker}]\n${utterance}` });

    for (let step = 0; step < 8; step++) {
      const response = await this.anthropic.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        tools: s.tools,
        messages: s.messages,
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        cache_control: { type: "ephemeral" },
      });

      if (response.stop_reason === "refusal") {
        emit({ type: "say", text: "Sorry, I can't help with that one." });
        s.messages.length = turnStart; // drop the whole refused turn; earlier history stays untouched
        return;
      }
      // Append the full content (thinking, fallback and tool_use blocks included) unchanged.
      s.messages.push({ role: "assistant", content: response.content });

      const spoken = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim();
      const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");

      if (response.stop_reason === "pause_turn") continue;
      if (!toolUses.length) {
        if (spoken) emit({ type: "say", text: spoken });
        return;
      }

      // Run every tool call from this step concurrently, then return all results in one user message.
      const results = await Promise.all(toolUses.map((tu) => this.runTool(tu, emit)));
      s.messages.push({ role: "user", content: results });
    }
    emit({ type: "say", text: "Sorry, that took me too many steps. Could you ask again?" });
  }

  private async runTool(tu: Anthropic.Beta.BetaToolUseBlock, emit: (e: AgentEvent) => void): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    emit({ type: "tool_call", name: tu.name, args: tu.input });
    try {
      const result = await this.mcp.request(
        { method: "tools/call", params: { name: tu.name, arguments: tu.input as Record<string, unknown> } },
        CallToolResultSchema,
        { timeout: 300_000 }, // elicitation waits on a human
      );
      const textOut = result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
      emit({ type: "tool_result", name: tu.name, text: textOut, isError: Boolean(result.isError) });

      // MCP Apps: if the tool declares a UI resource, fetch it and hand it to the screen.
      const meta = this.session?.mcpTools.get(tu.name)?._meta as { ui?: { resourceUri?: string } } | undefined;
      const uri = meta?.ui?.resourceUri;
      if (uri && !result.isError) {
        const res = await this.mcp.readResource({ uri });
        const html = res.contents.find((c) => c.mimeType === UI_MIME && "text" in c);
        if (html && "text" in html) emit({ type: "ui", toolName: tu.name, html: html.text, toolInput: tu.input, toolResult: result });
      }
      return { type: "tool_result", tool_use_id: tu.id, content: textOut || "(no output)", is_error: Boolean(result.isError) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "tool_result", name: tu.name, text: message, isError: true });
      return { type: "tool_result", tool_use_id: tu.id, content: `Tool failed: ${message}`, is_error: true };
    }
  }
}
