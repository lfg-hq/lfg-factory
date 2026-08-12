import type { ColorPalette, FontPairing, StyleProfile, DesignTokens } from "./schema.ts";
import { DesignTokensSchema } from "./schema.ts";
import palettesData from "./palettes.json";
import fontPairingsData from "./font-pairings.json";
import styleProfilesData from "./style-profiles.json";

const palettes = palettesData as ColorPalette[];
const fontPairings = fontPairingsData as FontPairing[];
const styleProfiles = styleProfilesData as StyleProfile[];

// --- WCAG Contrast Utilities ---

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// --- Mood Signal Extraction ---

const MOOD_KEYWORDS: Record<string, string[]> = {
  professional: ["business", "enterprise", "corporate", "b2b", "crm", "dashboard", "admin", "management"],
  modern: ["saas", "platform", "app", "startup", "product"],
  tech: ["developer", "api", "code", "devtool", "engineering", "technical", "data", "analytics"],
  elegant: ["luxury", "premium", "boutique", "exclusive", "high-end"],
  natural: ["eco", "green", "sustainable", "organic", "nature", "plant", "garden"],
  calm: ["meditation", "mindful", "wellness", "zen", "peaceful", "relax"],
  health: ["fitness", "workout", "nutrition", "medical", "health", "clinic", "patient"],
  warm: ["cozy", "warm", "comfort", "home", "family", "community"],
  energetic: ["sport", "action", "fast", "dynamic", "game"],
  creative: ["art", "design", "portfolio", "creative", "studio", "agency"],
  bold: ["bold", "strong", "powerful", "impact"],
  playful: ["fun", "play", "game", "social", "kids", "colorful"],
  friendly: ["friendly", "social", "community", "chat", "connect"],
  minimal: ["minimal", "simple", "clean", "stripped", "basic"],
  editorial: ["blog", "magazine", "news", "article", "publish", "journal"],
  futuristic: ["crypto", "blockchain", "nft", "web3", "ai", "ml", "future"],
  trustworthy: ["bank", "finance", "insurance", "legal", "secure", "trust"],
  feminine: ["beauty", "cosmetic", "fashion", "style", "skincare"],
  luxury: ["luxury", "premium", "exclusive", "gold", "diamond"],
  rustic: ["rustic", "vintage", "retro", "craft", "artisan", "handmade"],
};

const INDUSTRY_KEYWORDS: Record<string, string[]> = {
  saas: ["saas", "platform", "dashboard", "admin", "crm"],
  fintech: ["finance", "bank", "payment", "trading", "invest", "money"],
  analytics: ["analytics", "chart", "metric", "report", "data", "insight"],
  "developer-tools": ["developer", "api", "code", "devtool", "cli", "sdk"],
  health: ["health", "medical", "patient", "clinic", "fitness", "workout"],
  wellness: ["wellness", "meditation", "yoga", "mindful", "spa"],
  sustainability: ["eco", "green", "sustainable", "carbon", "recycle"],
  food: ["food", "recipe", "restaurant", "meal", "cooking", "kitchen", "menu"],
  travel: ["travel", "booking", "hotel", "flight", "trip", "vacation"],
  finance: ["finance", "budget", "expense", "accounting", "billing"],
  education: ["education", "course", "learn", "study", "school", "quiz", "tutor"],
  healthcare: ["healthcare", "hospital", "doctor", "appointment", "pharmacy"],
  fashion: ["fashion", "clothing", "outfit", "style", "wardrobe"],
  beauty: ["beauty", "cosmetic", "skincare", "makeup"],
  lifestyle: ["lifestyle", "home", "decor", "interior"],
  "real-estate": ["property", "real-estate", "house", "rental", "apartment"],
  hospitality: ["hotel", "resort", "booking", "hospitality"],
  social: ["social", "chat", "community", "forum", "network", "feed"],
  gaming: ["game", "gaming", "esport", "arcade", "leaderboard"],
  entertainment: ["music", "video", "stream", "media", "podcast"],
  creative: ["portfolio", "design", "studio", "agency", "creative"],
  marketplace: ["marketplace", "shop", "store", "ecommerce", "product", "cart"],
  enterprise: ["enterprise", "workflow", "approval", "team", "organization"],
  productivity: ["todo", "task", "project", "productivity", "kanban", "note"],
  crypto: ["crypto", "blockchain", "nft", "web3", "defi", "token", "wallet"],
};

interface MoodSignals {
  moods: string[];
  industries: string[];
  explicitScheme?: "warm" | "cool" | "neutral";
  isDark?: boolean;
}

function extractMoodSignals(requirements: string): MoodSignals {
  const lower = requirements.toLowerCase();
  const moods: string[] = [];
  const industries: string[] = [];

  for (const [mood, keywords] of Object.entries(MOOD_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      moods.push(mood);
    }
  }

  for (const [industry, keywords] of Object.entries(INDUSTRY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      industries.push(industry);
    }
  }

  let explicitScheme: "warm" | "cool" | "neutral" | undefined;
  if (lower.includes("warm") || lower.includes("cozy")) explicitScheme = "warm";
  else if (lower.includes("cool") || lower.includes("cold")) explicitScheme = "cool";

  const isDark =
    lower.includes("dark") || lower.includes("night") || lower.includes("midnight")
      ? true
      : lower.includes("light") || lower.includes("bright") || lower.includes("white")
        ? false
        : undefined;

  if (moods.length === 0) moods.push("modern");

  return { moods, industries, explicitScheme, isDark };
}

// --- Scoring & Selection ---

function scorePalette(palette: ColorPalette, signals: MoodSignals): number {
  let score = 0;
  for (const m of signals.moods) {
    if (palette.mood.includes(m)) score += 3;
  }
  for (const ind of signals.industries) {
    if (palette.industries.includes(ind)) score += 2;
  }
  if (signals.explicitScheme && palette.scheme === signals.explicitScheme) score += 4;

  if (signals.isDark !== undefined) {
    const bgLum = relativeLuminance(palette.colors.background);
    const paletteIsDark = bgLum < 0.2;
    if (signals.isDark === paletteIsDark) score += 5;
    else score -= 5;
  }

  return score;
}

function scoreFontPairing(fp: FontPairing, signals: MoodSignals): number {
  let score = 0;
  for (const m of signals.moods) {
    if (fp.mood.includes(m)) score += 3;
  }
  return score;
}

function scoreStyleProfile(sp: StyleProfile, signals: MoodSignals): number {
  let score = 0;
  for (const m of signals.moods) {
    if (sp.mood.includes(m)) score += 3;
  }
  return score;
}

function weightedRandomPick<T>(items: T[], scores: number[], topN: number): T {
  const indexed = items
    .map((item, i) => ({ item, score: scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  const minScore = Math.min(...indexed.map((x) => x.score));
  const shifted = indexed.map((x) => ({ ...x, weight: x.score - minScore + 1 }));
  const totalWeight = shifted.reduce((sum, x) => sum + x.weight, 0);
  let rand = Math.random() * totalWeight;

  for (const entry of shifted) {
    rand -= entry.weight;
    if (rand <= 0) return entry.item;
  }
  return shifted[0]!.item;
}

// --- Type Scale Generation ---

type TypeScale = { xs: string; sm: string; base: string; lg: string; xl: string; "2xl": string; "3xl": string; "4xl": string };

function generateTypeScale(ratio: number): TypeScale {
  const base = 1; // 1rem = 16px
  return {
    xs: `${(base / ratio / ratio).toFixed(3)}rem`,
    sm: `${(base / ratio).toFixed(3)}rem`,
    base: `${base}rem`,
    lg: `${(base * ratio).toFixed(3)}rem`,
    xl: `${(base * ratio * ratio).toFixed(3)}rem`,
    "2xl": `${(base * Math.pow(ratio, 3)).toFixed(3)}rem`,
    "3xl": `${(base * Math.pow(ratio, 4)).toFixed(3)}rem`,
    "4xl": `${(base * Math.pow(ratio, 5)).toFixed(3)}rem`,
  };
}

// --- Main Compose Function ---

export interface DesignOverrides {
  paletteId?: string;
  fontPairingId?: string;
  styleProfileId?: string;
  /** Hard light/dark constraint from the user. Overrides a conflicting paletteId. */
  brightness?: "light" | "dark";
}

export interface PalettePreference {
  /** Hard constraint: the user explicitly asked for "light" or "dark". */
  brightness?: "light" | "dark";
  /** Free-text vibe/requirements used to score among brightness-matching palettes. */
  mood?: string;
  /** A preferred palette id — honored ONLY if it fits the brightness constraint. */
  preferredPaletteId?: string;
}

/**
 * Select a palette from a stated PREFERENCE rather than a hard id. Brightness is a hard
 * constraint: a preferred paletteId is honored only if it matches (so the agent asking
 * for "light" can never end up with a dark palette), otherwise the scorer picks the
 * best brightness-matching palette by mood.
 */
export function selectPalette(pref: PalettePreference): ColorPalette {
  const signals = extractMoodSignals([pref.mood ?? "", pref.brightness ?? ""].join(" "));
  if (pref.brightness) signals.isDark = pref.brightness === "dark"; // explicit pref wins

  if (pref.preferredPaletteId) {
    const p = getPaletteById(pref.preferredPaletteId);
    if (p) {
      const paletteIsDark = relativeLuminance(p.colors.background) < 0.2;
      if (signals.isDark === undefined || paletteIsDark === signals.isDark) return p;
      console.warn(
        `[design-tokens] preferred palette '${p.id}' is ${paletteIsDark ? "dark" : "light"} but request asks for ${signals.isDark ? "dark" : "light"} — selecting a ${signals.isDark ? "dark" : "light"} palette instead.`
      );
    }
  }
  const scores = palettes.map((p) => scorePalette(p, signals));
  return weightedRandomPick(palettes, scores, 5);
}

// Explicit light/dark phrasing a user or plan is likely to use. Ordered so a clear
// "light UI" intent isn't clobbered by an incidental "dark" elsewhere in the spec.
const LIGHT_PHRASES = [
  "light dashboard", "light ui", "light-themed", "light themed", "light theme",
  "light mode", "light colored", "light-colored", "light and", "clean light",
  "bright and", "white background", "on a light", "minimal light",
];
const DARK_PHRASES = [
  "dark dashboard", "dark ui", "dark-themed", "dark themed", "dark theme",
  "dark mode", "dark professional", "midnight", "night mode", "on a dark", "moody dark",
];

/**
 * Infer a light/dark preference from free text (requirements + plan summary/sections)
 * when the orchestrator didn't pass an explicit `brightness`. This makes the light/dark
 * choice deterministic instead of depending on the model remembering to set the flag —
 * a user who answered "clean light dashboard" reliably gets a light palette.
 *
 * Returns undefined when the text gives no clear signal (or is contradictory), so the
 * caller falls back to mood-based scoring.
 */
export function inferBrightness(text: string | undefined | null): "light" | "dark" | undefined {
  const lower = (text ?? "").toLowerCase();
  if (!lower.trim()) return undefined;
  const light = LIGHT_PHRASES.some((p) => lower.includes(p)) || /\blight\b/.test(lower);
  const dark =
    DARK_PHRASES.some((p) => lower.includes(p)) ||
    (/\bdark\b/.test(lower) && !/dark mode toggle|light\/dark|light or dark/.test(lower));
  if (light && !dark) return "light";
  if (dark && !light) return "dark";
  return undefined; // no signal, or both present (ambiguous) → let mood scoring decide
}

export function composeDesignTokens(requirements: string, _appName: string, overrides?: DesignOverrides): DesignTokens {
  // Font/style use explicit ids directly; palette uses preference-based selectPalette.
  const explicitFont = overrides?.fontPairingId ? getFontPairingById(overrides.fontPairingId) : undefined;
  const explicitStyle = overrides?.styleProfileId ? getStyleProfileById(overrides.styleProfileId) : undefined;

  const signals = extractMoodSignals(requirements);

  const fontScores = fontPairings.map((f) => scoreFontPairing(f, signals));
  const styleScores = styleProfiles.map((s) => scoreStyleProfile(s, signals));

  // Palette comes from a PREFERENCE (brightness + mood), not a raw id — so an explicit
  // light/dark choice is always honored even if the model's preferred palette conflicts.
  const palette = selectPalette({
    brightness: overrides?.brightness,
    mood: requirements,
    preferredPaletteId: overrides?.paletteId,
  });
  const fontPairing = explicitFont ?? weightedRandomPick(fontPairings, fontScores, 4);
  const styleProfile = explicitStyle ?? weightedRandomPick(styleProfiles, styleScores, 3);

  const tokens: DesignTokens = {
    meta: {
      paletteName: palette.name,
      fontPairingName: fontPairing.name,
      styleProfileName: styleProfile.name,
      generatedAt: new Date().toISOString(),
    },
    colors: { ...palette.colors },
    typography: {
      headingFont: fontPairing.headingFont,
      bodyFont: fontPairing.bodyFont,
      monoFont: fontPairing.monoFont,
      scale: generateTypeScale(fontPairing.scaleRatio),
      weights: {
        normal: fontPairing.bodyWeight,
        medium: 500,
        semibold: 600,
        bold: 700,
        heading: fontPairing.headingWeight,
      },
      lineHeights: {
        tight: "1.25",
        normal: "1.5",
        relaxed: "1.75",
      },
    },
    style: {
      borderRadius: { ...styleProfile.borderRadius },
      shadows: { ...styleProfile.shadows },
      transitionSpeed: styleProfile.transitionSpeed,
      hoverScale: styleProfile.hoverScale,
      hoverLift: styleProfile.hoverLift,
    },
  };

  const issues = validateTokens(tokens);
  // Only READABILITY failures (WCAG contrast) or schema errors disqualify a palette.
  // A "differentiation" nit — primary≈destructive (a delete-button color) or
  // surface≈background — is cosmetic and must NOT collapse a mood-matched palette to
  // the hardcoded dark default. That collapse is exactly why "playful & colorful"
  // kept landing on dark Midnight Indigo: violet-dream scored highest but got rejected
  // over its red destructive vs purple primary, then fell back to palettes[0] (dark).
  const fatal = issues.filter((i) => i.type === "contrast" || i.type === "scale");
  if (fatal.length > 0) {
    // Even the last-resort fallback must respect the chosen brightness — never return a
    // dark palette for a light request. Derive it from the (correctly brightness-picked)
    // palette we were about to use.
    const isDark = relativeLuminance(palette.colors.background) < 0.2;
    console.warn(`[design-tokens] fatal validation issues, using ${isDark ? "dark" : "light"} fallback:`, fatal);
    return composeDefaultTokens(isDark);
  }
  if (issues.length > 0) {
    console.warn(`[design-tokens] minor design-token issues (accepted, palette kept):`, issues);
  }

  return tokens;
}

function composeDefaultTokens(isDark?: boolean): DesignTokens {
  // Pick a brightness-matching default so a light request never falls back to a dark
  // palette (and vice-versa). Only when brightness is unknown do we use palettes[0].
  const p =
    isDark === undefined
      ? palettes[0]!
      : palettes.find((pl) => (relativeLuminance(pl.colors.background) < 0.2) === isDark) ?? palettes[0]!;
  const f = fontPairings[0]!;
  const s = styleProfiles[1]!;
  return {
    meta: {
      paletteName: p.name,
      fontPairingName: f.name,
      styleProfileName: s.name,
      generatedAt: new Date().toISOString(),
    },
    colors: { ...p.colors },
    typography: {
      headingFont: f.headingFont,
      bodyFont: f.bodyFont,
      monoFont: f.monoFont,
      scale: generateTypeScale(f.scaleRatio),
      weights: { normal: 400, medium: 500, semibold: 600, bold: 700, heading: 700 },
      lineHeights: { tight: "1.25", normal: "1.5", relaxed: "1.75" },
    },
    style: {
      borderRadius: { ...s.borderRadius },
      shadows: { ...s.shadows },
      transitionSpeed: s.transitionSpeed,
      hoverScale: s.hoverScale,
      hoverLift: s.hoverLift,
    },
  };
}

// --- Validation ---

export interface ValidationIssue {
  type: "contrast" | "differentiation" | "scale";
  message: string;
}

export function validateTokens(tokens: DesignTokens): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const c = tokens.colors;

  // WCAG AA: normal text needs 4.5:1 against background
  const textBgRatio = contrastRatio(c.text, c.background);
  if (textBgRatio < 4.5) {
    issues.push({ type: "contrast", message: `Text/background contrast ${textBgRatio.toFixed(2)} < 4.5:1` });
  }

  // Text on card
  const cardTextRatio = contrastRatio(c.cardForeground, c.card);
  if (cardTextRatio < 4.5) {
    issues.push({ type: "contrast", message: `Card text contrast ${cardTextRatio.toFixed(2)} < 4.5:1` });
  }

  // Primary button text
  const primaryBtnRatio = contrastRatio(c.primaryForeground, c.primary);
  if (primaryBtnRatio < 3) {
    issues.push({ type: "contrast", message: `Primary button contrast ${primaryBtnRatio.toFixed(2)} < 3:1` });
  }

  // Primary vs destructive differentiation
  const primDestRatio = contrastRatio(c.primary, c.destructive);
  if (primDestRatio < 1.5) {
    issues.push({ type: "differentiation", message: `Primary and destructive too similar (ratio ${primDestRatio.toFixed(2)})` });
  }

  // Surface vs background minimum delta
  const surfBgRatio = contrastRatio(c.surface, c.background);
  if (surfBgRatio < 1.05) {
    issues.push({ type: "differentiation", message: `Surface and background indistinguishable (ratio ${surfBgRatio.toFixed(2)})` });
  }

  // Validate via Zod schema
  const parsed = DesignTokensSchema.safeParse(tokens);
  if (!parsed.success) {
    issues.push({ type: "scale", message: `Schema validation failed: ${parsed.error.message}` });
  }

  return issues;
}

// --- CSS Custom Properties Generation ---

export function generateTokensCss(tokens: DesignTokens): string {
  const c = tokens.colors;

  function hexToHslString(hex: string): string {
    const rgb = hexToRgb(hex).map((v) => v / 255);
    const r = rgb[0]!, g = rgb[1]!, b = rgb[2]!;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;

    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }

    return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
  }

  const hsl = (hex: string) => hexToHslString(hex);

  return `/* Design Tokens — Auto-generated by LFG */
/* Palette: ${tokens.meta.paletteName} | Fonts: ${tokens.meta.fontPairingName} | Style: ${tokens.meta.styleProfileName} */

@layer base {
  :root {
    --background: ${hsl(c.background)};
    --foreground: ${hsl(c.text)};
    --card: ${hsl(c.card)};
    --card-foreground: ${hsl(c.cardForeground)};
    --popover: ${hsl(c.popover)};
    --popover-foreground: ${hsl(c.popoverForeground)};
    --primary: ${hsl(c.primary)};
    --primary-foreground: ${hsl(c.primaryForeground)};
    --secondary: ${hsl(c.secondary)};
    --secondary-foreground: ${hsl(c.secondaryForeground)};
    --muted: ${hsl(c.muted)};
    --muted-foreground: ${hsl(c.mutedForeground)};
    --accent: ${hsl(c.accent)};
    --accent-foreground: ${hsl(c.accentForeground)};
    --destructive: ${hsl(c.destructive)};
    --border: ${hsl(c.border)};
    --input: ${hsl(c.input)};
    --ring: ${hsl(c.ring)};

    /* Extended tokens */
    --surface: ${hsl(c.surface)};
    --surface-hover: ${hsl(c.surfaceHover)};
    --text-muted: ${hsl(c.textMuted)};
    --primary-hover: ${hsl(c.primaryHover)};
    --border-strong: ${hsl(c.borderStrong)};
    --success: ${hsl(c.success)};
    --warning: ${hsl(c.warning)};

    /* Border Radius */
    --radius: ${tokens.style.borderRadius.default};
    --radius-sm: ${tokens.style.borderRadius.sm};
    --radius-lg: ${tokens.style.borderRadius.lg};
    --radius-full: ${tokens.style.borderRadius.full};

    /* Shadows */
    --shadow-sm: ${tokens.style.shadows.sm};
    --shadow-md: ${tokens.style.shadows.md};
    --shadow-lg: ${tokens.style.shadows.lg};

    /* Typography */
    --font-heading: '${tokens.typography.headingFont}', system-ui, sans-serif;
    --font-body: '${tokens.typography.bodyFont}', system-ui, sans-serif;
    --font-mono: '${tokens.typography.monoFont}', monospace;
    --font-weight-heading: ${tokens.typography.weights.heading};

    /* Transitions */
    --transition-speed: ${tokens.style.transitionSpeed};
    --hover-scale: ${tokens.style.hoverScale};
    --hover-lift: ${tokens.style.hoverLift};
  }
}
`;
}

// --- Tailwind Config Extension ---

export function generateTailwindExtend(tokens: DesignTokens): string {
  return `// Tailwind theme extension — auto-generated by LFG
// Add this to your tailwind.config.ts extend section
{
  fontFamily: {
    heading: ['${tokens.typography.headingFont}', 'system-ui', 'sans-serif'],
    body: ['${tokens.typography.bodyFont}', 'system-ui', 'sans-serif'],
    mono: ['${tokens.typography.monoFont}', 'monospace'],
  },
  fontSize: ${JSON.stringify(Object.fromEntries(
    Object.entries(tokens.typography.scale).map(([k, v]) => [k, v])
  ), null, 4)},
  borderRadius: {
    sm: 'var(--radius-sm)',
    DEFAULT: 'var(--radius)',
    lg: 'var(--radius-lg)',
    full: 'var(--radius-full)',
  },
  boxShadow: {
    sm: 'var(--shadow-sm)',
    DEFAULT: 'var(--shadow-md)',
    lg: 'var(--shadow-lg)',
  },
  transitionDuration: {
    DEFAULT: '${tokens.style.transitionSpeed}',
  },
}`;
}

// --- Lookup helpers for swap_theme ---

export function getPaletteById(id: string): ColorPalette | undefined {
  return palettes.find((p) => p.id === id);
}

export function getFontPairingById(id: string): FontPairing | undefined {
  return fontPairings.find((f) => f.id === id);
}

export function getStyleProfileById(id: string): StyleProfile | undefined {
  return styleProfiles.find((s) => s.id === id);
}

// Resolve a canonical ID from EITHER an id or a display name (case-insensitive).
// The orchestrator and older metadata sometimes carry display names ("Slate Minimal")
// where an id ("slate-minimal") is expected — these normalize both back to the id.
export function resolvePaletteId(idOrName?: string | null): string | undefined {
  if (!idOrName) return undefined;
  const v = String(idOrName).trim(); const lc = v.toLowerCase();
  return palettes.find((p) => p.id === v || p.id.toLowerCase() === lc || p.name.toLowerCase() === lc)?.id;
}

export function resolveFontPairingId(idOrName?: string | null): string | undefined {
  if (!idOrName) return undefined;
  const v = String(idOrName).trim(); const lc = v.toLowerCase();
  return fontPairings.find((f) => f.id === v || f.id.toLowerCase() === lc || f.name.toLowerCase() === lc)?.id;
}

export function resolveStyleProfileId(idOrName?: string | null): string | undefined {
  if (!idOrName) return undefined;
  const v = String(idOrName).trim(); const lc = v.toLowerCase();
  return styleProfiles.find((s) => s.id === v || s.id.toLowerCase() === lc || s.name.toLowerCase() === lc)?.id;
}

export function getAllPaletteIds(): string[] {
  return palettes.map((p) => p.id);
}

export function getAllFontPairingIds(): string[] {
  return fontPairings.map((f) => f.id);
}

export function getAllStyleProfileIds(): string[] {
  return styleProfiles.map((s) => s.id);
}

export function recomposeTokens(
  paletteId?: string,
  fontPairingId?: string,
  styleProfileId?: string,
  existingTokens?: DesignTokens
): DesignTokens | null {
  const palette = paletteId ? getPaletteById(paletteId) : undefined;
  const fp = fontPairingId ? getFontPairingById(fontPairingId) : undefined;
  const sp = styleProfileId ? getStyleProfileById(styleProfileId) : undefined;

  if (!palette && !fp && !sp) return null;

  const base = existingTokens ?? composeDefaultTokens();

  const tokens: DesignTokens = {
    meta: {
      paletteName: palette?.name ?? base.meta.paletteName,
      fontPairingName: fp?.name ?? base.meta.fontPairingName,
      styleProfileName: sp?.name ?? base.meta.styleProfileName,
      generatedAt: new Date().toISOString(),
    },
    colors: palette ? { ...palette.colors } : base.colors,
    typography: fp
      ? {
          headingFont: fp.headingFont,
          bodyFont: fp.bodyFont,
          monoFont: fp.monoFont,
          scale: generateTypeScale(fp.scaleRatio),
          weights: {
            normal: fp.bodyWeight,
            medium: 500,
            semibold: 600,
            bold: 700,
            heading: fp.headingWeight,
          },
          lineHeights: { tight: "1.25", normal: "1.5", relaxed: "1.75" },
        }
      : base.typography,
    style: sp
      ? {
          borderRadius: { ...sp.borderRadius },
          shadows: { ...sp.shadows },
          transitionSpeed: sp.transitionSpeed,
          hoverScale: sp.hoverScale,
          hoverLift: sp.hoverLift,
        }
      : base.style,
  };

  const issues = validateTokens(tokens);
  if (issues.length > 0) return null;

  return tokens;
}

// ─────────────────────────────────────────────────────────────────────────────
// Color-selection tool: compose full tokens from a base palette + per-role picks.
// The user picks a curated base palette, then overrides individual roles (primary/
// accent/secondary/background/text) from a provided swatch set. We derive the
// dependent tokens (foreground via WCAG contrast, hover via a lightness shift) so an
// override stays coherent and readable.
// ─────────────────────────────────────────────────────────────────────────────

function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
/** Linear mix of two hex colors (ratio 0 = a, 1 = b). */
function mixHex(a: string, b: string, ratio: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const t = Math.max(0, Math.min(1, ratio));
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}
const darkenHex = (hex: string, r: number) => mixHex(hex, "#000000", r);
const lightenHex = (hex: string, r: number) => mixHex(hex, "#ffffff", r);
/** Pick the most readable foreground (near-white or near-black) for a background. */
function pickForeground(bg: string): string {
  const light = "#ffffff", dark = "#111114";
  return contrastRatio(bg, light) >= contrastRatio(bg, dark) ? light : dark;
}
const isValidHex = (s: string | undefined): s is string => !!s && /^#[0-9a-fA-F]{6}$/.test(s);

export type ColorRole = "primary" | "accent" | "secondary" | "background" | "text";

/**
 * The provided swatch options per role — the distinct, curated colors used across the
 * built-in palettes (so a user only ever picks harmonious, real palette colors).
 */
export function getPaletteSwatchOptions(): Record<ColorRole, string[]> {
  const uniq = (arr: string[]) => Array.from(new Set(arr.map((c) => c.toLowerCase())));
  return {
    primary: uniq(palettes.map((p) => p.colors.primary)),
    accent: uniq(palettes.map((p) => p.colors.accent)),
    secondary: uniq(palettes.map((p) => p.colors.secondary)),
    background: uniq(palettes.map((p) => p.colors.background)),
    text: uniq(palettes.map((p) => p.colors.text)),
  };
}

/**
 * Compose full DesignTokens from a base palette + per-role color overrides. Unspecified
 * roles keep the base palette's value. Dependent tokens (foreground/hover/muted/surface)
 * are re-derived from each override so the result stays coherent + accessible.
 */
export function composeTokensFromSelection(
  baseId: string,
  overrides: Partial<Record<ColorRole, string>>,
  fontPairingId?: string,
  styleProfileId?: string,
  existingTokens?: DesignTokens,
): DesignTokens | null {
  const base = recomposeTokens(baseId, fontPairingId, styleProfileId, existingTokens) ?? composeDefaultTokens();
  const c = { ...base.colors };

  if (isValidHex(overrides.primary)) {
    c.primary = overrides.primary;
    c.primaryForeground = pickForeground(c.primary);
    c.primaryHover = relativeLuminance(c.primary) > 0.5 ? darkenHex(c.primary, 0.12) : lightenHex(c.primary, 0.1);
    c.ring = c.primary;
  }
  if (isValidHex(overrides.accent)) {
    c.accent = overrides.accent;
    c.accentForeground = pickForeground(c.accent);
  }
  if (isValidHex(overrides.secondary)) {
    c.secondary = overrides.secondary;
    c.secondaryForeground = pickForeground(c.secondary);
  }
  if (isValidHex(overrides.background)) {
    const bg = overrides.background;
    const dark = relativeLuminance(bg) < 0.4;
    c.background = bg;
    c.surface = dark ? lightenHex(bg, 0.05) : darkenHex(bg, 0.03);
    c.surfaceHover = dark ? lightenHex(bg, 0.1) : darkenHex(bg, 0.06);
    c.card = c.surface;
    c.popover = c.surface;
    c.muted = dark ? lightenHex(bg, 0.08) : darkenHex(bg, 0.05);
    c.input = dark ? lightenHex(bg, 0.14) : darkenHex(bg, 0.09);
  }
  if (isValidHex(overrides.text)) {
    c.text = overrides.text;
    c.cardForeground = c.text;
    c.popoverForeground = c.text;
    c.textMuted = mixHex(c.text, c.background, 0.45);
    c.mutedForeground = c.textMuted;
  }

  const tokens: DesignTokens = {
    ...base,
    meta: { ...base.meta, generatedAt: base.meta.generatedAt },
    colors: c,
  };
  const parsed = DesignTokensSchema.safeParse(tokens);
  return parsed.success ? parsed.data : tokens;
}
