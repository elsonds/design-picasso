/**
 * Settings Dialog for LLM Configuration
 * Manages API keys, model selection, provider toggle (OpenAI / Gemini)
 */

'use client';

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Settings, X, Check } from 'lucide-react';
import {
  getStoredConfig,
  saveConfig,
  validateConfig,
  isConfigured,
  getActiveProvider,
  setActiveProvider,
  type LLMConfig,
  type LLMProvider,
} from './llm-service';
import {
  getStoredGeminiConfig,
  saveGeminiConfig,
  isGeminiConfigured,
  validateGeminiConfig,
  type GeminiConfig,
} from './gemini-service';

interface SettingsDialogProps {
  onConfigChange?: (config: LLMConfig) => void;
  onProviderChange?: (provider: LLMProvider) => void;
  triggerClassName?: string;
}

const OPENAI_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo',
];

const GEMINI_MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
];

export const SettingsDialog: React.FC<SettingsDialogProps> = ({
  onConfigChange,
  onProviderChange,
  triggerClassName = '',
}) => {
  const [isOpen, setIsOpen] = useState(false);

  // Provider toggle
  const [provider, setProvider] = useState<LLMProvider>('openai');

  // OpenAI fields
  const [model, setModel] = useState('gpt-4o-mini');
  const [temperature, setTemperature] = useState(0.8);

  // Gemini fields
  const [geminiModel, setGeminiModel] = useState('gemini-2.0-flash');
  const [geminiTemperature, setGeminiTemperature] = useState(0.8);

  // UI state
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Load configs on open
  useEffect(() => {
    const activeProvider = getActiveProvider();
    setProvider(activeProvider);

    const openaiConfig = getStoredConfig();
    if (openaiConfig) {
      setModel(openaiConfig.model);
      setTemperature(openaiConfig.temperature);
    }

    const geminiConfig = getStoredGeminiConfig();
    if (geminiConfig) {
      setGeminiModel(geminiConfig.model);
      setGeminiTemperature(geminiConfig.temperature);
    }
  }, [isOpen]);

  const handleSave = () => {
    setError(null);
    setSuccess(false);

    const openaiConfig: LLMConfig = {
      model,
      temperature,
      maxTokens: 2000,
      provider: 'openai',
    };

    const geminiConfig: GeminiConfig = {
      model: geminiModel,
      temperature: geminiTemperature,
      maxTokens: 4000,
    };

    try {
      saveConfig(openaiConfig);
      saveGeminiConfig(geminiConfig);
      setActiveProvider(provider);

      setSuccess(true);

      if (onProviderChange) {
        onProviderChange(provider);
      }
      if (onConfigChange) {
        onConfigChange(openaiConfig);
      }

      setTimeout(() => {
        setIsOpen(false);
      }, 2000);
    } catch {
      setError('Failed to save configuration');
    }
  };

  const handleClose = () => {
    setIsOpen(false);
    setError(null);
    setSuccess(false);
  };

  const activeModels = provider === 'gemini' ? GEMINI_MODELS : OPENAI_MODELS;
  const activeModel = provider === 'gemini' ? geminiModel : model;
  const activeTemp = provider === 'gemini' ? geminiTemperature : temperature;

  return (
    <>
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen(true)}
        className={`relative p-1.5 rounded-lg transition-colors hover:bg-white/5 ${triggerClassName}`}
        style={{ color: '#e2e8f0' }}
        title="LLM Settings"
      >
        <Settings size={16} />
      </button>

      {/* Modal Overlay */}
      {isOpen && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 99999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-[#1e1e2e] rounded-lg shadow-2xl w-full max-w-md border border-[#2d2d44]">
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-[#2d2d44]">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <Settings size={20} />
                LLM Settings
              </h2>
              <button
                onClick={handleClose}
                className="text-gray-400 hover:text-gray-200 transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Content */}
            <div className="p-6 space-y-5">
              {/* Provider Toggle */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Provider
                </label>
                <div className="flex rounded-lg overflow-hidden border border-[#3d3d54]">
                  <button
                    onClick={() => { setProvider('openai'); setSuccess(false); }}
                    className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                      provider === 'openai'
                        ? 'bg-blue-600 text-white'
                        : 'bg-[#2d2d44] text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    OpenAI
                  </button>
                  <button
                    onClick={() => { setProvider('gemini'); setSuccess(false); }}
                    className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                      provider === 'gemini'
                        ? 'bg-blue-600 text-white'
                        : 'bg-[#2d2d44] text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    Gemini
                  </button>
                </div>
              </div>

              {/* Model Dropdown */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Model
                </label>
                <select
                  value={activeModel}
                  onChange={(e) => {
                    if (provider === 'gemini') setGeminiModel(e.target.value);
                    else setModel(e.target.value);
                    setSuccess(false);
                  }}
                  className="w-full px-3 py-2 bg-[#2d2d44] border border-[#3d3d54] rounded text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                >
                  {activeModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  {provider === 'gemini'
                    ? 'gemini-2.0-flash is recommended for speed'
                    : 'gpt-4o-mini is recommended for fast responses'}
                </p>
              </div>

              {/* Temperature Slider */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Temperature: {activeTemp.toFixed(2)}
                </label>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={activeTemp}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (provider === 'gemini') setGeminiTemperature(val);
                    else setTemperature(val);
                    setSuccess(false);
                  }}
                  className="w-full h-2 bg-[#2d2d44] rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
                <div className="flex justify-between text-xs text-gray-500 mt-1">
                  <span>Deterministic</span>
                  <span>Creative</span>
                </div>
              </div>

              {/* Error Message */}
              {error && (
                <div className="p-3 rounded bg-red-500 bg-opacity-20 border border-red-500 border-opacity-30 text-red-300 text-sm">
                  {error}
                </div>
              )}

              {/* Success Message */}
              {success && (
                <div className="p-3 rounded bg-green-500 bg-opacity-20 border border-green-500 border-opacity-30 text-green-300 text-sm flex items-center gap-2">
                  <Check size={16} />
                  Settings saved successfully
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex gap-3 p-6 border-t border-[#2d2d44]">
              <button
                onClick={handleClose}
                className="flex-1 px-4 py-2 bg-[#2d2d44] text-gray-300 rounded hover:bg-[#3d3d54] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors font-medium"
              >
                Save
              </button>
            </div>
          </div>
        </div>,
        document.getElementById('modal-root') || document.body
      )}
    </>
  );
};

export default SettingsDialog;
