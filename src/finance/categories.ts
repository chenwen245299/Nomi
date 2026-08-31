import {
  RiBookOpenLine,
  RiBusLine,
  RiGamepadLine,
  RiGiftLine,
  RiHeartPulseLine,
  RiHome4Line,
  RiMoreLine,
  RiPlaneLine,
  RiRestaurantLine,
  RiShoppingBag3Line,
  RiSmartphoneLine,
} from "@remixicon/react";

// ── Category presentation ────────────────────────────────────────────────────
// The canonical list lives in the backend (`CATEGORIES` in src-tauri/src/finance)
// — it is what the model is told to choose from, and it arrives with
// `financeStatus()`. This file only says how each one *looks*, and answers for
// any name it has never seen, so the two can drift without breaking the UI.
//
// The colours are a supporting set for small dots and chips; the section's own
// rose accent stays the thing that tints the chrome.

export interface CategoryStyle {
  color: string;
  icon: typeof RiMoreLine;
}

const FALLBACK: CategoryStyle = { color: "#78818F", icon: RiMoreLine };

const STYLES: Record<string, CategoryStyle> = {
  餐饮: { color: "#D9803A", icon: RiRestaurantLine },
  交通: { color: "#3C7FD4", icon: RiBusLine },
  购物: { color: "#C2507A", icon: RiShoppingBag3Line },
  居住: { color: "#2F9182", icon: RiHome4Line },
  娱乐: { color: "#7A5BD0", icon: RiGamepadLine },
  医疗: { color: "#CC5057", icon: RiHeartPulseLine },
  教育: { color: "#4C63C4", icon: RiBookOpenLine },
  人情: { color: "#C29A2E", icon: RiGiftLine },
  通讯: { color: "#2E93B0", icon: RiSmartphoneLine },
  旅行: { color: "#4F9B4A", icon: RiPlaneLine },
  其他: FALLBACK,
};

export function categoryStyle(category: string): CategoryStyle {
  return STYLES[category] ?? FALLBACK;
}

/** Money reads red when it leaves and green when it arrives. */
export const EXPENSE_COLOR = "#B24D4D";
export const INCOME_COLOR = "#2A7A66";
