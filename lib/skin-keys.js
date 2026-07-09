/**
 * Unified skin key generation for consistent matching across:
 * - fetch-clean-skins.js (baseline collection)
 * - analyze-charms.js (profit analysis)
 * - fetch-charms.js (charm collection)
 */

export function normalizeExterior(exterior) {
  if (!exterior) return exterior;
  // Normalize exterior names to handle variations like "Battle-Scarred" vs "Battle Scarred"
  return exterior.replace(/[-\s]/g, '').toLowerCase();
}

/**
 * Generate base skin key (name only)
 * Used for grouping skins by base name
 */
export function getBaseSkinKey(item) {
  const name = item.nameHash || item.name;
  if (!name) return null;
  // Remove exterior from name like "AK-47 | Aphrodite (Battle-Scarred)" -> "AK-47 | Aphrodite"
  return name.replace(/\s*\([^)]+\)\s*$/, '').trim();
}

/**
 * Generate variant skin key (name + exterior)
 * Used for exact variant matching for reliable pricing
 */
export function getVariantSkinKey(item) {
  const baseName = getBaseSkinKey(item);
  const exterior = normalizeExterior(item.exterior);
  if (!baseName) return null;
  return `${baseName}|${exterior}`;
}

/**
 * Generate full skin key (name + exterior + paintSeed)
 * Used for exact pattern matching (rarely needed)
 */
export function getExactSkinKey(item) {
  const variantKey = getVariantSkinKey(item);
  if (!variantKey) return null;
  if (item.paintSeed != null) {
    return `${variantKey}|${item.paintSeed}`;
  }
  return variantKey;
}

/**
 * Legacy key for compatibility with existing code
 * Use getVariantSkinKey for new code
 */
export function getSkinKey(item) {
  return item.nameHash || item.name;
}
