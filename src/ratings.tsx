import { useState } from "react";
import { Pressable, Text, View, type ViewStyle } from "react-native";
import { RiStarFill, RiStarLine } from "@remixicon/react";
import { motion, type Accent } from "./theme";

// ── Star rating (5 = best, 1 = worst, 0 = unrated) ────────────────────────────

const GOLD = "#E0952B";

/** Compact single-star + number, for dense list cards (e.g. ★ 4). */
export function StarChip({ rating, size = 12 }: { rating: number; size?: number }) {
  if (!rating) return null;
  return (
    <View style={{ alignItems: "center", flexDirection: "row", gap: 2 } as ViewStyle}>
      <RiStarFill color={GOLD} size={size} />
      <Text style={{ color: GOLD, fontSize: 11.5, fontWeight: "700" }}>{rating}</Text>
    </View>
  );
}

/** Read-only stars for list cards and previews. */
export function StarsInline({ rating, size = 13 }: { rating: number; size?: number }) {
  if (!rating) return null;
  return (
    <View style={{ flexDirection: "row", gap: 1 } as ViewStyle}>
      {Array.from({ length: 5 }, (_, index) =>
        index < rating ? (
          <RiStarFill color={GOLD} key={index} size={size} />
        ) : (
          <RiStarLine color="rgba(60,70,85,0.25)" key={index} size={size} />
        ),
      )}
    </View>
  );
}

/** Interactive 5-star picker. Clicking the current single star clears to 0. */
export function StarRating({
  rating,
  onChange,
  accent,
  size = 26,
}: {
  rating: number;
  onChange: (rating: number) => void;
  accent: Accent;
  size?: number;
}) {
  const [hover, setHover] = useState(0);
  const shown = hover || rating;
  return (
    <View style={{ alignItems: "center", flexDirection: "row", gap: 4 } as ViewStyle}>
      {Array.from({ length: 5 }, (_, index) => {
        const value = index + 1;
        const filled = value <= shown;
        return (
          <Pressable
            accessibilityLabel={`评 ${value} 星`}
            accessibilityRole="button"
            key={value}
            onHoverIn={() => setHover(value)}
            onHoverOut={() => setHover(0)}
            onPress={() => onChange(rating === value ? 0 : value)}
            style={motion}
          >
            {/* The icon is swapped between two different components as the hover
                preview moves, which replaces the DOM node under the cursor. When
                that re-render lands between pointerdown and pointerup the press
                gesture is broken and the click is silently lost — reliably so
                when rating up from empty stars, and always on touch, where there
                is no hover phase before the press. Taking the icon out of hit
                testing keeps both events on the Pressable's own node, which is
                stable. */}
            <View pointerEvents="none">
              {filled ? (
                <RiStarFill color={GOLD} size={size} />
              ) : (
                <RiStarLine color="rgba(60,70,85,0.28)" size={size} />
              )}
            </View>
          </Pressable>
        );
      })}
      <Text style={{ color: accent.accentText, fontSize: 12, fontWeight: "600", marginLeft: 6 }}>
        {rating ? `${rating}/5` : "未评分"}
      </Text>
    </View>
  );
}
