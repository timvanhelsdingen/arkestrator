/**
 * Pre-configured agent config templates for common engines.
 * These are static data served from the server (not in DB),
 * so they stay current across updates.
 */
export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  engine: string;
  command: string;
  args: string[];
  model?: string;
  maxTurns: number;
  systemPrompt?: string;
  priority: number;
  onboarding?: AgentTemplateOnboarding;
}

export interface AgentTemplateOnboarding {
  title: string;
  steps: string[];
  links?: Array<{
    label: string;
    url: string;
  }>;
  commands?: string[];
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Anthropic Claude Code CLI — pick model (Opus/Sonnet/Haiku) via the model selector",
    engine: "claude-code",
    command: "claude",
    args: [],
    model: "claude-sonnet-4-20250514",
    maxTurns: 300,
    priority: 50,
    onboarding: {
      title: "Sign in to Claude Code",
      steps: [
        "Run 'claude /login' in the server terminal (Docker: docker exec -it arkestrator claude /login).",
        "Complete the device/browser auth flow.",
        "Auth tokens persist in HOME volume across restarts.",
      ],
      links: [
        {
          label: "Claude Code Quickstart",
          url: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
        },
      ],
      commands: [
        "claude /login",
        "docker exec -it arkestrator claude /login",
      ],
    },
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    description: "Google Gemini CLI for code generation",
    engine: "gemini",
    command: "gemini",
    args: [],
    maxTurns: 300,
    priority: 50,
    onboarding: {
      title: "Configure Gemini credentials",
      steps: [
        "Create a Gemini API key in Google AI Studio.",
        "Set GOOGLE_API_KEY (or GEMINI_API_KEY) in the Arkestrator runtime environment.",
        "Restart Arkestrator after setting env vars.",
      ],
      links: [
        {
          label: "Get a Gemini API key",
          url: "https://aistudio.google.com/app/apikey",
        },
      ],
      commands: [
        "export GOOGLE_API_KEY=your_key_here",
      ],
    },
  },
  {
    id: "codex-cli",
    name: "Codex CLI",
    description: "OpenAI Codex CLI agent",
    engine: "codex",
    command: "codex",
    args: [],
    maxTurns: 300,
    priority: 50,
    onboarding: {
      title: "Authorize Codex CLI",
      steps: [
        "Run 'codex auth' in the server terminal (Docker: docker exec -it arkestrator codex auth).",
        "Complete the device/browser auth flow.",
        "Alternatively, set OPENAI_API_KEY in the runtime environment.",
      ],
      links: [
        {
          label: "Codex CLI auth guide",
          url: "https://help.openai.com/en/articles/11381614-api-codex-cli-and-sign-in-with-chatgpt",
        },
      ],
      commands: [
        "codex auth",
        "docker exec -it arkestrator codex auth",
      ],
    },
  },
  {
    id: "grok-cli",
    name: "Grok CLI",
    description: "xAI Grok CLI for code generation",
    engine: "grok",
    command: "grok",
    args: [],
    maxTurns: 400,
    priority: 50,
    onboarding: {
      title: "Configure Grok credentials",
      steps: [
        "Create an API key at console.x.ai.",
        "Set GROK_API_KEY in the Arkestrator runtime environment.",
        "Restart Arkestrator after setting env vars.",
      ],
      links: [
        {
          label: "xAI API Console",
          url: "https://console.x.ai/",
        },
      ],
      commands: [
        "export GROK_API_KEY=your_key_here",
      ],
    },
  },
  {
    id: "ollama-local",
    name: "Ollama (Local)",
    description: "Run local models through Ollama. Uses args placeholders for model + prompt.",
    engine: "local-oss",
    command: "ollama",
    args: ["run", "{{MODEL}}"],
    model: "llama3.2:latest",
    maxTurns: 300,
    priority: 50,
  },
  {
    id: "custom-local",
    name: "Custom Local Model",
    description: "Template for a local/OSS model - fill in command/args/model. Args support {{MODEL}} and {{PROMPT}} placeholders.",
    engine: "local-oss",
    command: "your-command",
    args: [],
    model: "your-model-name",
    maxTurns: 300,
    priority: 50,
  },
];
