/**
 * Gemini Chat Service
 * Routes through Supabase Edge Function proxy — API keys stay server-side.
 */

import type { ChatMessage } from './llm-service';
import { supabaseUrl, supabaseKey } from './supabase-client';

const LLM_PROXY_URL = `${supabaseUrl}/functions/v1/server/make-server-1a0af268/llm/chat`;

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

// ─── Streaming chat via Supabase Edge Function proxy ────────────────────────

/**
 * Stream chat completions via the LLM proxy
 * The Edge Function handles Gemini format conversion server-side
 */
export async function streamGeminiChat(
  messages: ChatMessage[],
  config: GeminiConfig,
  onChunk: (chunk: string) => void
): Promise<string> {
  try {
    const response = await fetch(LLM_PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        messages,
        provider: 'gemini',
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        stream: true,
      }),
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
  // Use streaming version and accumulate
  let accumulated = '';
  await streamGeminiChat(messages, config, (chunk) => {
    accumulated += chunk;
  });
  return accumulated;
}
