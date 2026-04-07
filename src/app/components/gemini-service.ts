/**
 * Gemini Chat Service
 * Handles streaming chat completions via Google's Generative Language API
 * Drop-in alternative to OpenAI for the conceptualise flow
 */

import type { ChatMessage } from './llm-service';

export interface GeminiConfig {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

const DEFAULT_GEMINI_CONFIG: Partial<GeminiConfig> = {
  model: 'gemini-2.0-flash',
  temperature: 0.8,
  maxTokens: 4000,
};

const STORAGE_KEY = 'picasso_gemini_config';

// ─── Config persistence ──────────────────────────────────────────────────────

export function getStoredGeminiConfig(): GeminiConfig | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    return { ...DEFAULT_GEMINI_CONFIG, ...parsed } as GeminiConfig;
  } catch {
    return null;
  }
}

export function saveGeminiConfig(config: GeminiConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (error) {
    console.error('Failed to save Gemini config:', error);
  }
}

export function isGeminiConfigured(): boolean {
  const config = getStoredGeminiConfig();
  return Boolean(config?.apiKey);
}

export function validateGeminiConfig(config: Partial<GeminiConfig>): string | null {
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    return 'Gemini API key is required';
  }
  if (!config.model) {
    return 'Model is required';
  }
  return null;
}

// ─── Streaming chat via Gemini REST API ──────────────────────────────────────

/**
 * Convert our ChatMessage format to Gemini's contents format.
 * Gemini uses "user" and "model" roles, and system instructions go separately.
 */
function convertMessages(messages: ChatMessage[]): {
  systemInstruction: string | null;
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
} {
  let systemInstruction: string | null = null;
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Gemini treats system instructions separately
      systemInstruction = (systemInstruction ? systemInstruction + '\n\n' : '') + msg.content;
    } else {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
    }
  }

  return { systemInstruction, contents };
}

/**
 * Stream chat completions from Gemini API
 * Parses SSE-like stream and calls onChunk for each text delta
 */
export async function streamGeminiChat(
  messages: ChatMessage[],
  config: GeminiConfig,
  onChunk: (chunk: string) => void
): Promise<string> {
  const { systemInstruction, contents } = convertMessages(messages);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:streamGenerateContent?alt=sse&key=${config.apiKey}`;

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: config.temperature,
      maxOutputTokens: config.maxTokens,
    },
  };

  if (systemInstruction) {
    body.systemInstruction = {
      parts: [{ text: systemInstruction }],
    };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `Gemini API error (${response.status})`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorMessage;
      } catch {
        errorMessage = errorText || errorMessage;
      }
      throw new Error(errorMessage);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable');
    }

    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines[lines.length - 1];

      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line || line === ':') continue;

        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const json = JSON.parse(data);
            // Gemini streams candidates[0].content.parts[0].text
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              fullText += text;
              onChunk(text);
            }
          } catch {
            // Ignore malformed lines
          }
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim() && buffer.trim().startsWith('data: ')) {
      const data = buffer.trim().slice(6);
      if (data !== '[DONE]') {
        try {
          const json = JSON.parse(data);
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            fullText += text;
            onChunk(text);
          }
        } catch {
          // Ignore
        }
      }
    }

    return fullText;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Gemini stream error: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Non-streaming Gemini chat — for simple single-response calls
 */
export async function geminiChat(
  messages: ChatMessage[],
  config: GeminiConfig
): Promise<string> {
  const { systemInstruction, contents } = convertMessages(messages);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: config.temperature,
      maxOutputTokens: config.maxTokens,
    },
  };

  if (systemInstruction) {
    body.systemInstruction = {
      parts: [{ text: systemInstruction }],
    };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage = `Gemini API error (${response.status})`;
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage = errorJson.error?.message || errorMessage;
    } catch {
      errorMessage = errorText || errorMessage;
    }
    throw new Error(errorMessage);
  }

  const json = await response.json();
  return json.candidates?.[0]?.content?.parts?.[0]?.text || '';
}
