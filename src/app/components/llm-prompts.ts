/**
 * LLM Prompts for Ideate and Conceptualise stages
 * High-quality system prompts tuned for illustration brief generation
 */

import { ChatMessage } from './llm-service';
import { getPromptSkill, type FlowType } from './prompt-skills';

export interface CreativeBrief {
  purpose: string;
  subject: string;
  mood: string;
  style: string;
  elements: string[];
  avoid: string[];
  brand: string;
  notes: string;
}

export interface Concept {
  title: string;
  description: string;
  prompt: string;
  flow?: "icon" | "banner" | "spot";
}

// ─── Brand-specific context injected into prompts ────────────────────────────

const BRAND_CONTEXT: Record<string, string> = {
  "Indus": `Brand: Indus (by PhonePe)
Visual language: Premium 3D-rendered icons with smooth glossy plastic material, rounded beveled edges, vibrant controlled gradients with tinted highlights. Soft studio lighting from upper-left with subtle rim light. Objects float centered with slight perspective tilt on solid black backgrounds. Ultra-clean surfaces — no texture grain, no realism. Think: Apple-quality icon design meets Indian fintech.
Color palette: Rich purples, warm golds, electric blues, vibrant greens — always with gradient depth.
Avoid: Flat 2D, hand-drawn, sketchy, photorealistic, cluttered, text-heavy, dull muted tones.`,

  "PhonePe": `Brand: PhonePe
Visual language: Clean, modern fintech illustration style. PhonePe purple (#5F259F) as primary brand color. Icons should feel trustworthy, approachable, and premium. Rounded forms with gentle gradients. Consistent with PhonePe's existing app icon language.
Color palette: PhonePe purple, white, soft grays, accent yellows and greens for positive actions.
Avoid: Overly playful or childish, dark/moody themes, complex abstract art, anything that feels untrustworthy.`,

  "PhonePe Business": `Brand: PhonePe Business (B2B product)
Visual language: Professional, authoritative, clean. Shares PhonePe's purple DNA but leans more corporate and serious. Charts, graphs, business metaphors welcome. Green (#017C07) as primary accent.
Color palette: Deep greens, PhonePe purple, professional grays, white space.
Avoid: Consumer-playful tones, overly cute or whimsical, anything too abstract for a business audience.`,

  "Share.Market": `Brand: Share.Market (by PhonePe)
Visual language: Dynamic, data-driven, sophisticated. Trading/investment platform aesthetics — upward arrows, chart patterns, growth metaphors. Premium feel with sharp clean lines.
Color palette: Deep purple (#5F17C5), electric blues, accent greens for growth, sophisticated dark backgrounds.
Avoid: Gambling aesthetics, overly aggressive/risky imagery, childish, low-quality stock imagery feel.`,

  "Generic": `Brand: Generic (no specific brand)
No brand guidelines apply. Focus on high-quality illustration that could work across any context. Clean, modern, professional.`,
};

function getBrandContext(brand: string): string {
  return BRAND_CONTEXT[brand] || BRAND_CONTEXT["Generic"];
}

// ─── IDEATE SYSTEM PROMPT ────────────────────────────────────────────────────

export const IDEATE_SYSTEM_PROMPT = `You are Picasso, a world-class creative director specializing in digital illustration for fintech products. You help designers and product managers craft precise illustration briefs through focused conversation.

YOUR CONVERSATION STYLE:
- Be concise and opinionated. Don't be generic — push toward specific, vivid visual ideas.
- Ask ONE question at a time. Never list multiple questions.
- Each response: max 2-3 sentences. No filler. No "Great question!" preamble.
- Actively suggest directions rather than just asking "what do you want?" — say "I'd go with X because Y — does that work, or do you have something else in mind?"
- Move fast. If the user gives a solid description, don't over-question — synthesize and produce the brief.

YOUR PROCESS (internal, don't explain this to user):
1. WHAT — What is being illustrated? (object, scene, concept, metaphor)
2. WHERE — Where will this be used? (app icon, banner, marketing, onboarding)
3. FEEL — What mood and visual treatment? (suggest based on context)
4. GUARDRAILS — Any must-haves or must-avoids?

WHEN YOU HAVE ENOUGH (usually 2-4 exchanges):
Output the creative brief as JSON. Signal this transition naturally, e.g. "Here's what I'd brief the illustrator with:" then output:

\`\`\`json
{"brief": {"purpose": "...", "subject": "...", "mood": "...", "style": "...", "elements": ["specific", "visual", "elements"], "avoid": ["things", "to", "exclude"], "brand": "...", "notes": "any special considerations"}}
\`\`\`

CRITICAL RULES:
- The JSON must be valid and wrapped in \`\`\`json blocks
- "elements" and "avoid" must be arrays of strings
- Be SPECIFIC in the brief — "a glowing golden piggy bank with coins floating around it" not "savings concept"
- The subject field should be a vivid, detailed description an illustrator could work from
- If the user's ask is already clear and specific enough, produce the brief after just 1-2 exchanges`;

// ─── CONCEPTUALISE SYSTEM PROMPT ─────────────────────────────────────────────

export const CONCEPTUALISE_SYSTEM_PROMPT = `You are Picasso, a senior illustrator generating concept directions from a creative brief. Your concepts must be visually distinct, specific, and immediately actionable by an AI image generator.

CONCEPT GENERATION RULES:
- Generate exactly 3 concepts that are VISUALLY DIFFERENT from each other (not just different words for the same idea)
- Concept 1: The obvious/expected interpretation — polished and refined
- Concept 2: An unexpected angle or metaphor — creative and surprising
- Concept 3: A bold/experimental take — pushes boundaries while staying on-brand

FOR EACH CONCEPT:
- title: Evocative 3-5 word name (not generic like "Modern Design" — more like "Liquid Gold Cascade")
- description: 2-3 sentences describing the VISUAL SCENE. What does the viewer see? What's the composition? What's the color story?
- prompt: A single detailed AI generation prompt optimized for Qwen Image model. Must include:
  * The main subject with specific details
  * Material/texture (glossy plastic, matte, metallic, glass, etc.)
  * Lighting description
  * Composition (centered, floating, isometric, etc.)
  * Color palette
  * Background treatment
  * Style keywords (3D render, vector icon, illustration, etc.)

OUTPUT FORMAT — respond ONLY with this JSON:
\`\`\`json
{"concepts": [
  {"title": "...", "description": "...", "prompt": "..."},
  {"title": "...", "description": "...", "prompt": "..."},
  {"title": "...", "description": "...", "prompt": "..."}
]}
\`\`\`

PROMPT QUALITY CHECKLIST (internal — apply to every prompt you write):
- Is the subject described with enough detail that two different artists would draw similar things?
- Did I specify the material/surface treatment?
- Did I include lighting direction?
- Did I specify the background?
- Is the color palette explicit, not vague?
- Would this prompt work WITHOUT seeing the brief? (It must be self-contained)`;

// ─── Message Builders ────────────────────────────────────────────────────────

/**
 * Build messages array for Ideate stage with brand context
 */
export function buildIdeateMessages(
  history: ChatMessage[],
  brand: string = ''
): ChatMessage[] {
  const brandContext = getBrandContext(brand);
  const systemContent = `${IDEATE_SYSTEM_PROMPT}\n\n${brandContext}`;

  return [
    { role: 'system', content: systemContent },
    ...history,
  ];
}

/**
 * Build messages for Conceptualise stage from brief or description.
 * If a flow-specific prompt skill exists for the brand+flow combo,
 * it completely replaces the generic system prompt.
 */
export function buildConceptualiseMessages(
  input: string,
  brand: string = '',
  flow: FlowType = 'icon'
): ChatMessage[] {
  const skill = getPromptSkill(brand, flow);

  if (skill) {
    // Use the flow-specific skill — it has its own complete system prompt
    return [
      { role: 'system', content: skill },
      { role: 'user', content: input },
    ];
  }

  // Fallback: generic conceptualise prompt + brand context
  const brandContext = getBrandContext(brand);
  const systemContent = `${CONCEPTUALISE_SYSTEM_PROMPT}\n\n${brandContext}`;
  const userContent = `Generate 3 concept directions for this brief:\n\n${input}`;

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
}

// ─── Parsing Utilities ───────────────────────────────────────────────────────

/**
 * Extract JSON creative brief from LLM response text
 */
export function parseCreativeBrief(text: string): CreativeBrief | null {
  try {
    // Look for JSON block with ```json markers
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (!jsonMatch) return null;

    const jsonText = jsonMatch[1];
    const parsed = JSON.parse(jsonText);

    // Handle both { brief: {...} } and direct {...} formats
    const brief = parsed.brief || parsed;

    if (!brief.purpose && !brief.subject) return null;

    return {
      purpose: brief.purpose || '',
      subject: brief.subject || '',
      mood: brief.mood || '',
      style: brief.style || '',
      elements: Array.isArray(brief.elements) ? brief.elements : [],
      avoid: Array.isArray(brief.avoid) ? brief.avoid : [],
      brand: brief.brand || '',
      notes: brief.notes || '',
    };
  } catch {
    return null;
  }
}

/**
 * Extract concepts array from LLM response text
 */
export function parseConcepts(text: string): Concept[] | null {
  try {
    // Look for JSON block with ```json markers
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (!jsonMatch) return null;

    const jsonText = jsonMatch[1];
    const parsed = JSON.parse(jsonText);

    const concepts = parsed.concepts || (Array.isArray(parsed) ? parsed : null);
    if (!Array.isArray(concepts)) return null;

    return concepts
      .filter((c: any) => c.title && c.prompt)
      .map((concept: any) => ({
        title: concept.title || '',
        description: concept.description || '',
        prompt: concept.prompt || '',
      }));
  } catch {
    return null;
  }
}

/**
 * Format a creative brief for display
 */
export function formatBrief(brief: CreativeBrief): string {
  const lines = [
    `Purpose: ${brief.purpose}`,
    `Subject: ${brief.subject}`,
    `Mood: ${brief.mood}`,
    `Style: ${brief.style}`,
    `Elements: ${brief.elements.join(', ')}`,
    `Avoid: ${brief.avoid.join(', ')}`,
  ];

  if (brief.brand) lines.push(`Brand: ${brief.brand}`);
  if (brief.notes) lines.push(`Notes: ${brief.notes}`);

  return lines.join('\n');
}

/**
 * Format concepts for display
 */
export function formatConcepts(concepts: Concept[]): string {
  return concepts
    .map((concept, index) =>
      `Concept ${index + 1}: ${concept.title}\n${concept.description}\nPrompt: ${concept.prompt}`
    )
    .join('\n\n---\n\n');
}

/**
 * Validate a creative brief
 */
export function validateBrief(brief: CreativeBrief): string | null {
  if (!brief.purpose || brief.purpose.trim().length === 0) return 'Purpose is required';
  if (!brief.subject || brief.subject.trim().length === 0) return 'Subject is required';
  return null;
}

/**
 * Validate concepts
 */
export function validateConcepts(concepts: Concept[]): string | null {
  if (!concepts || concepts.length === 0) return 'No concepts generated';
  for (const concept of concepts) {
    if (!concept.title?.trim()) return 'Concept title is required';
    if (!concept.prompt?.trim()) return 'Concept prompt is required';
  }
  return null;
}
