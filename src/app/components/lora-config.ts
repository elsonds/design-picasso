/**
 * LoRA Configuration Map
 * Maps brand + flow combinations to the correct LoRA safetensors file and strength.
 *
 * LoRA files deployed on RunPod ComfyUI:
 * - indus-style.safetensors              (Indus brand, icon flow)
 * - indus-banner-style.safetensors       (Indus brand, banner flow)
 * - ppe_style.safetensors                (PhonePe brand, icon flow)
 *
 * Edit model (separate checkpoint, not a LoRA):
 * - Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors
 */

export interface LoraConfig {
  lora_name: string;
  strength: number;
  controlnet_strength?: number; // Higher strength for ControlNet workflows
}

/**
 * LoRA lookup: brand -> flow -> config
 * Falls back gracefully: unknown brand -> Generic (no LoRA), unknown flow -> icon
 */
const LORA_MAP: Record<string, Record<string, LoraConfig>> = {
  "Indus": {
    icon: {
      lora_name: "indus-style.safetensors",
      strength: 1.0,
      controlnet_strength: 1.5,
    },
    banner: {
      lora_name: "indus-banner-style.safetensors",
      strength: 1.06,
      controlnet_strength: 1.5,
    },
    spot: {
      lora_name: "indus-banner-style.safetensors",
      strength: 1.06,
      controlnet_strength: 1.5,
    },
  },
  "PhonePe": {
    icon: {
      lora_name: "ppe_style.safetensors",
      strength: 1.0,
      controlnet_strength: 1.5,
    },
    banner: {
      // PhonePe banner LoRA not yet trained — fallback to PhonePe icon at lower strength
      lora_name: "ppe_style.safetensors",
      strength: 0.7,
      controlnet_strength: 1.0,
    },
    spot: {
      lora_name: "ppe_style.safetensors",
      strength: 0.8,
      controlnet_strength: 1.2,
    },
  },
  "PhonePe Business": {
    icon: {
      lora_name: "ppe_style.safetensors",
      strength: 0.9,
      controlnet_strength: 1.3,
    },
    banner: {
      lora_name: "ppe_style.safetensors",
      strength: 0.6,
      controlnet_strength: 1.0,
    },
    spot: {
      lora_name: "ppe_style.safetensors",
      strength: 0.7,
      controlnet_strength: 1.0,
    },
  },
  "Share.Market": {
    icon: {
      lora_name: "indus-style.safetensors",
      strength: 0.8,
      controlnet_strength: 1.2,
    },
    banner: {
      lora_name: "indus-banner-style.safetensors",
      strength: 0.7,
      controlnet_strength: 1.0,
    },
    spot: {
      lora_name: "indus-style.safetensors",
      strength: 0.6,
      controlnet_strength: 1.0,
    },
  },
};

/**
 * Default fallback LoRA (used for unknown brand combos — NOT Generic)
 */
const DEFAULT_LORA: LoraConfig = {
  lora_name: "indus-style.safetensors",
  strength: 0.6,
  controlnet_strength: 1.0,
};

/**
 * Get the LoRA config for a brand + flow combination.
 * Returns null for Generic brand (no LoRA applied — raw Qwen model).
 */
export function getLoraConfig(
  brand: string,
  flow: "icon" | "banner" | "spot" = "icon"
): LoraConfig | null {
  // Generic brand = no LoRA, just the base Qwen model
  if (brand === "Generic") return null;

  const brandMap = LORA_MAP[brand];
  if (!brandMap) return DEFAULT_LORA;

  return brandMap[flow] || brandMap["icon"] || DEFAULT_LORA;
}

/**
 * Get all available LoRA configurations (for settings/debug UI)
 */
export function getAllLoraConfigs(): Record<string, Record<string, LoraConfig>> {
  return LORA_MAP;
}

/**
 * Get unique LoRA filenames across all configurations
 */
export function getUniqueLoraFiles(): string[] {
  const files = new Set<string>();
  for (const brand of Object.values(LORA_MAP)) {
    for (const config of Object.values(brand)) {
      files.add(config.lora_name);
    }
  }
  return Array.from(files);
}
