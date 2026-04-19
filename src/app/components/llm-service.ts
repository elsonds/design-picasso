/**
 * LLM Chat Service
 * Routes all LLM requests through Supabase Edge Function proxy.
 * API keys are stored as Supabase secrets — never in the browser.
 */

import { supabaseUrl, supabaseKey, supabase } from './supabase-client';

async function authHeader(): Promise<string> {
  try {
    const { data } = await supabase.auth.getSession();
    const t = data?.session?.access_token;
    if (t) return `Bearer ${t}`;
  } catch { /* ignore */ }
  return `Bearer ${supabaseKey}`;
}

const LLM_PROXY_URL = `${supabaseUrl}/functions/v1/server/make-server-1a0af268/llm/chat`;

export type LLMProvider = 'openai' | 'gemini';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMConfig {
  model: string;
  temperature: number;
  maxTokens: number;
  provider?: LLMProvider;
  /** @deprecated API keys are now managed server-side via Supabase secrets */
  apiKey?: string;
}

const DEFAULT_CONFIG: Partial<LLMConfig> = {
  model: 'gpt-4o-mini',
  temperature: 0.8,
  maxTokens: 2000,
  provider: 'openai',
};

const STORAGE_KEY = 'picasso_llm_config';
const PROVIDER_KEY = 'picasso_llm_provider';

/**
 * Get/set active LLM provider
 */
export function getActiveProvider(): LLMProvider {
  try {
    return (localStorage.getItem(PROVIDER_KEY) as LLMProvider) || 'openai';
  } catch {
    return 'openai';
  }
}

export function setActiveProvider(provider: LLMProvider): void {
  try {
    localStorage.setItem(PROVIDER_KEY, provider);
  } catch {
    // ignore
  }
}

/**
 * Get stored LLM config from localStorage
 */
export function getStoredConfig(): LLMConfig | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
    } as LLMConfig;
  } catch {
    return null;
  }
}

/**
 * Save LLM config to localStorage
 */
export function saveConfig(config: LLMConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (error) {
    console.error('Failed to save LLM config:', error);
  }
}

/**
 * Check if LLM is configured (always true — keys are server-side)
 */
export function isConfigured(): boolean {
  return true;
}

/**
 * Validate LLM configuration
 */
export function validateConfig(config: Partial<LLMConfig>): string | null {
  if (!config.model) {
    return 'Model is required';
  }
  if (config.temperature === undefined || config.temperature === null) {
    return 'Temperature is required';
  }
  if (config.temperature < 0 || config.temperature > 2) {
    return 'Temperature must be between 0 and 2';
  }
  if (!config.maxTokens || config.maxTokens < 1) {
    return 'Max tokens must be greater than 0';
  }
  return null;
}

/**
 * Stream chat completions from OpenAI
 * Parses SSE stream and calls onChunk callback for each delta
 * Returns the complete accumulated response
 */
export async function streamChat(
  messages: ChatMessage[],
  config: LLMConfig,
  onChunk: (chunk: string) => void
): Promise<string> {
  try {
    const response = await fetch(LLM_PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': await authHeader(),
      },
      body: JSON.stringify({
        messages,
        provider: 'openai',
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `OpenAI API error (${response.status})`;
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

      // Keep the last incomplete line in the buffer
      buffer = lines[lines.length - 1];

      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line || line === ':') continue;

        if (line.startsWith('data: ')) {
          const data = line.slice(6);

          if (data === '[DONE]') {
            continue;
          }

          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta;
            if (delta?.content) {
              const chunk = delta.content;
              fullText += chunk;
              onChunk(chunk);
            }
          } catch {
            // Silently ignore parsing errors for malformed lines
          }
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim() && buffer.trim().startsWith('data: ')) {
      const data = buffer.trim().slice(6);
      if (data !== '[DONE]') {
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) {
            const chunk = delta.content;
            fullText += chunk;
            onChunk(chunk);
          }
        } catch {
          // Silently ignore parsing errors
        }
      }
    }

    return fullText;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`LLM stream error: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Non-streaming chat completion
 * Useful for simple single-response calls
 */
export async function chat(
  messages: ChatMessage[],
  config: LLMConfig
): Promise<string> {
  return new Promise((resolve, reject) => {
    let accumulated = '';
    streamChat(messages, config, (chunk) => {
      accumulated += chunk;
    })
      .then(() => resolve(accumulated))
      .catch(reject);
  });
}

/**
 * Create a user message
 */
export function createUserMessage(content: string): ChatMessage {
  return {
    role: 'user',
    content,
  };
}

/**
 * Create a system message
 */
export function createSystemMessage(content: string): ChatMessage {
  return {
    role: 'system',
    content,
  };
}

/**
 * Create an assistant message
 */
export function createAssistantMessage(content: string): ChatMessage {
  return {
    role: 'assistant',
    content,
  };
}
