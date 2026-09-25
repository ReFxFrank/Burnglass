// Pure model-family recognition (no JSX) so it can be unit-tested in Node.
// Classify any model string into a provider family; a model only appears in the
// UI if it's in the logs Pulse reads, so families light up strictly on use.

export function modelFamily(model) {
  const m = String(model || '').toLowerCase();
  if (/claude|anthropic|^fable|^mythos|^opus|^sonnet|^haiku/.test(m)) return 'claude';
  if (/^gpt|^o\d|codex|chatgpt|davinci|^text-|openai/.test(m)) return 'openai';
  if (/gemini|^gemma|palm|bison/.test(m)) return 'google';
  if (/deepseek/.test(m)) return 'deepseek';
  if (/glm|chatglm|zhipu|z-ai|z\.ai/.test(m)) return 'glm';
  if (/llama|^meta/.test(m)) return 'meta';
  if (/grok/.test(m)) return 'xai';
  if (/qwen/.test(m)) return 'qwen';
  if (/mistral|mixtral|codestral|ministral/.test(m)) return 'mistral';
  if (/command|cohere/.test(m)) return 'cohere';
  return 'other';
}

// `color` is the brand hex (kept for tests and non-CSS consumers); the UI
// paints marks with `css` — a token (styles.css --fam-*) that light mode
// darkens so every mark keeps its contrast on white.
export const FAMILY_META = {
  claude:   { label: 'Anthropic', color: '#D97757', css: 'var(--fam-claude)' },
  openai:   { label: 'OpenAI',    color: '#0E9C7E', css: 'var(--fam-openai)' },
  google:   { label: 'Google',    color: '#4285F4', css: 'var(--fam-google)' },
  deepseek: { label: 'DeepSeek',  color: '#4D6BFE', css: 'var(--fam-deepseek)' },
  glm:      { label: 'Z.ai GLM',  color: '#0EA5C4', css: 'var(--fam-glm)' },
  meta:     { label: 'Meta',      color: '#0668E1', css: 'var(--fam-meta)' },
  xai:      { label: 'xAI',       color: '#c7c9cc', css: 'var(--fam-xai)' },
  qwen:     { label: 'Qwen',      color: '#7A6FF0', css: 'var(--fam-qwen)' },
  mistral:  { label: 'Mistral',   color: '#EE792F', css: 'var(--fam-mistral)' },
  cohere:   { label: 'Cohere',    color: '#39A0A0', css: 'var(--fam-cohere)' },
  other:    { label: 'Model',     color: '#8a8f98', css: 'var(--fam-other)' },
};
