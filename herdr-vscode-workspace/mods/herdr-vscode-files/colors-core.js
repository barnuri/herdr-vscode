// A stable colour per repo (or any name): the same name always gets the same palette slot.
export const PALETTE = ["ansi4", "ansi2", "ansi5", "ansi3", "ansi6", "ansi1", "ansi12", "ansi10", "ansi13", "ansi14"];

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

export function hashName(name) {
  let hash = FNV_OFFSET_BASIS;
  for (const char of String(name ?? "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash;
}

export const colorSlot = (name) => PALETTE[hashName(name) % PALETTE.length];
