import { z } from "zod";

// --- Color Palette ---

export const ColorTokensSchema = z.object({
  background: z.string(),
  surface: z.string(),
  surfaceHover: z.string(),
  text: z.string(),
  textMuted: z.string(),
  primary: z.string(),
  primaryHover: z.string(),
  primaryForeground: z.string(),
  secondary: z.string(),
  secondaryForeground: z.string(),
  border: z.string(),
  borderStrong: z.string(),
  ring: z.string(),
  destructive: z.string(),
  success: z.string(),
  warning: z.string(),
  muted: z.string(),
  mutedForeground: z.string(),
  accent: z.string(),
  accentForeground: z.string(),
  card: z.string(),
  cardForeground: z.string(),
  popover: z.string(),
  popoverForeground: z.string(),
  input: z.string(),
});

export const ColorPaletteSchema = z.object({
  id: z.string(),
  name: z.string(),
  mood: z.array(z.string()),
  industries: z.array(z.string()),
  scheme: z.enum(["warm", "cool", "neutral"]),
  colors: ColorTokensSchema,
});

// --- Font Pairing ---

export const FontPairingSchema = z.object({
  id: z.string(),
  name: z.string(),
  mood: z.array(z.string()),
  headingFont: z.string(),
  bodyFont: z.string(),
  monoFont: z.string(),
  headingWeight: z.number(),
  bodyWeight: z.number(),
  scaleRatio: z.number(),
});

// --- Style Profile ---

export const StyleProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mood: z.array(z.string()),
  borderRadius: z.object({
    sm: z.string(),
    default: z.string(),
    lg: z.string(),
    full: z.string(),
  }),
  shadows: z.object({
    sm: z.string(),
    md: z.string(),
    lg: z.string(),
    shadowColor: z.string(),
  }),
  transitionSpeed: z.string(),
  hoverScale: z.string(),
  hoverLift: z.string(),
});

// --- Composed Design Tokens ---

export const DesignTokensSchema = z.object({
  meta: z.object({
    paletteName: z.string(),
    fontPairingName: z.string(),
    styleProfileName: z.string(),
    generatedAt: z.string(),
  }),
  colors: ColorTokensSchema,
  typography: z.object({
    headingFont: z.string(),
    bodyFont: z.string(),
    monoFont: z.string(),
    scale: z.object({
      xs: z.string(),
      sm: z.string(),
      base: z.string(),
      lg: z.string(),
      xl: z.string(),
      "2xl": z.string(),
      "3xl": z.string(),
      "4xl": z.string(),
    }),
    weights: z.object({
      normal: z.number(),
      medium: z.number(),
      semibold: z.number(),
      bold: z.number(),
      heading: z.number(),
    }),
    lineHeights: z.object({
      tight: z.string(),
      normal: z.string(),
      relaxed: z.string(),
    }),
  }),
  style: z.object({
    borderRadius: z.object({
      sm: z.string(),
      default: z.string(),
      lg: z.string(),
      full: z.string(),
    }),
    shadows: z.object({
      sm: z.string(),
      md: z.string(),
      lg: z.string(),
      shadowColor: z.string(),
    }),
    transitionSpeed: z.string(),
    hoverScale: z.string(),
    hoverLift: z.string(),
  }),
});

// --- Inferred types ---

export type ColorTokens = z.infer<typeof ColorTokensSchema>;
export type ColorPalette = z.infer<typeof ColorPaletteSchema>;
export type FontPairing = z.infer<typeof FontPairingSchema>;
export type StyleProfile = z.infer<typeof StyleProfileSchema>;
export type DesignTokens = z.infer<typeof DesignTokensSchema>;
