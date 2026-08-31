import { Text, View, type ViewStyle } from "react-native";
import { useTheme, type Accent } from "../theme";

export function BrandIcon({
  accent,
  fallback,
  size,
  url,
}: {
  accent: Accent;
  fallback: string;
  size: number;
  url: string | null;
}) {
  const { t } = useTheme();
  const radius = Math.round(size * 0.28);
  if (url) {
    return (
      <View
        style={
          {
            alignItems: "center",
            backgroundColor: t.cardSurfaceAlt,
            borderRadius: radius,
            height: size,
            justifyContent: "center",
            overflow: "hidden",
            width: size,
          } as ViewStyle
        }
      >
        <img alt="" height={size} src={url} style={{ objectFit: "contain" }} width={size} />
      </View>
    );
  }
  return (
    <View
      style={
        {
          alignItems: "center",
          backgroundColor: accent.accent,
          borderRadius: radius,
          height: size,
          justifyContent: "center",
          width: size,
        } as ViewStyle
      }
    >
      <Text
        style={
          {
            color: t.onAccent,
            fontSize: Math.round(size * 0.46),
            fontWeight: "700",
          } as unknown as ViewStyle
        }
      >
        {fallback}
      </Text>
    </View>
  );
}
