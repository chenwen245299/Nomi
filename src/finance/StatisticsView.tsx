import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import {
  RiArrowDownLine,
  RiArrowUpLine,
  RiBarChart2Line,
  RiBarChartHorizontalLine,
  RiCalendarCheckLine,
  RiFundsLine,
  RiMagicLine,
  RiPieChartLine,
  RiStore2Line,
} from "@remixicon/react";
import { motion, useTheme, type Accent, type Theme } from "../theme";
import type { ExpenseRecord } from "./api";
import { categoryStyle } from "./categories";
import {
  convertRecords,
  loadExchangeRates,
  normalizeCurrencyCode,
  type ExchangeRateSnapshot,
} from "./exchangeRates";
import { formatMoney, todayKey } from "./format";
import {
  availableCurrencies,
  buildFinanceStatistics,
  type CategorySpend,
  type RankedSpend,
  type StatisticInsight,
  type TrendPoint,
  type TrendRange,
} from "./statistics";

type PressState = { hovered?: boolean; pressed: boolean };

/** localStorage key for the last display currency chosen in the statistics view. */
const DISPLAY_CURRENCY_KEY = "nomi.finance.displayCurrency";

const RANGE_LABELS: Record<TrendRange, string> = {
  day: "每日",
  week: "每周",
  month: "每月",
};

function makeStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    scroll: { flex: 1, minHeight: 0 },
    scrollContent: { paddingBottom: 40, paddingHorizontal: 20, paddingTop: 18 },
    content: { alignSelf: "center", gap: 18, maxWidth: 1080, width: "100%" },
    intro: {
      alignItems: "flex-start",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 12,
      justifyContent: "space-between",
    },
    introText: { flex: 1, minWidth: 220 },
    eyebrow: {
      color: accent.accentText,
      fontSize: 10.5,
      fontWeight: "700",
      letterSpacing: 0.8,
      marginBottom: 5,
      textTransform: "uppercase",
    },
    heading: { color: t.textPrimary, fontSize: 22, fontWeight: "700", letterSpacing: -0.55 },
    introCaption: { color: t.textTertiary, fontSize: 11.5, lineHeight: 18, marginTop: 4 },
    currencyWrap: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      height: 32,
      paddingHorizontal: 9,
    },
    currencySpinner: { marginLeft: 7 },
    rateWarning: {
      alignItems: "center",
      backgroundColor: accent.selectedFill,
      borderRadius: 9,
      flexDirection: "row",
      gap: 7,
      paddingHorizontal: 11,
      paddingVertical: 8,
    },
    rateWarningText: { color: t.textSecondary, flex: 1, fontSize: 10.5, lineHeight: 16 },
    metricGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    metricCard: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 13,
      borderWidth: 1,
      flexBasis: 180,
      flexGrow: 1,
      gap: 8,
      minHeight: 112,
      padding: 14,
    },
    metricTop: { alignItems: "center", flexDirection: "row", gap: 7 },
    metricIcon: {
      alignItems: "center",
      backgroundColor: accent.iconBadge,
      borderRadius: 7,
      height: 26,
      justifyContent: "center",
      width: 26,
    },
    metricLabel: { color: t.textSecondary, fontSize: 11.5, fontWeight: "600" },
    metricValue: {
      color: t.textPrimary,
      fontSize: 23,
      fontWeight: "700",
      letterSpacing: -0.7,
    },
    metricMeta: { color: t.textTertiary, fontSize: 10.5, lineHeight: 15 },
    delta: { alignItems: "center", flexDirection: "row", gap: 2 },
    prediction: {
      backgroundColor: accent.selectedFill,
      borderRadius: 15,
      gap: 13,
      overflow: "hidden",
      padding: 16,
      position: "relative",
    },
    predictionGlow: {
      backgroundColor: `rgba(${accent.rgb},0.10)`,
      borderRadius: 999,
      height: 180,
      position: "absolute",
      right: -50,
      top: -90,
      width: 180,
    },
    sectionHeadingRow: {
      alignItems: "center",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      justifyContent: "space-between",
      zIndex: 1,
    },
    sectionTitleWrap: { alignItems: "center", flexDirection: "row", gap: 7 },
    sectionTitle: { color: t.textPrimary, fontSize: 14, fontWeight: "700" },
    sectionCaption: { color: t.textTertiary, fontSize: 10.5, marginTop: 2 },
    confidence: {
      backgroundColor: "rgba(255,255,255,0.68)",
      borderRadius: 999,
      color: accent.accentText,
      fontSize: 10.5,
      fontWeight: "700",
      overflow: "hidden",
      paddingHorizontal: 9,
      paddingVertical: 5,
    },
    forecastGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, zIndex: 1 },
    forecastItem: { flexBasis: 160, flexGrow: 1, gap: 4 },
    forecastLabel: { color: t.textSecondary, fontSize: 11 },
    forecastValue: {
      color: t.textPrimary,
      fontSize: 19,
      fontWeight: "700",
      letterSpacing: -0.45,
    },
    forecastNote: { color: t.textSecondary, fontSize: 10.5, lineHeight: 16, zIndex: 1 },
    panel: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 14,
      borderWidth: 1,
      gap: 14,
      minWidth: 0,
      padding: 16,
    },
    trendPanel: { minHeight: 310 },
    rangeControl: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderRadius: 8,
      flexDirection: "row",
      padding: 2,
    },
    rangeButton: {
      alignItems: "center",
      borderRadius: 6,
      height: 26,
      justifyContent: "center",
      paddingHorizontal: 10,
    },
    rangeButtonActive: { backgroundColor: t.cardSurface, boxShadow: t.e1Solid },
    rangeButtonHover: { backgroundColor: t.controlHover },
    rangeText: { color: t.textTertiary, fontSize: 10.5, fontWeight: "600" },
    rangeTextActive: { color: t.textPrimary },
    splitRow: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
    splitPanel: { flexBasis: 340, flexGrow: 1 },
    donutBody: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 18 },
    donutLegend: { flex: 1, gap: 9, minWidth: 170 },
    legendRow: { alignItems: "center", flexDirection: "row", gap: 7 },
    legendDot: { borderRadius: 999, height: 8, width: 8 },
    legendName: { color: t.textSecondary, flex: 1, fontSize: 11 },
    legendAmount: { color: t.textPrimary, fontSize: 11, fontWeight: "600" },
    legendShare: { color: t.textTertiary, fontSize: 10, textAlign: "right", width: 33 },
    frequency: {
      borderTopColor: t.separator,
      borderTopWidth: 1,
      gap: 12,
      paddingTop: 14,
    },
    frequencyList: { gap: 11 },
    frequencyRow: { gap: 5 },
    frequencyTop: { alignItems: "center", flexDirection: "row", gap: 7 },
    frequencyDot: { borderRadius: 999, height: 7, width: 7 },
    frequencyName: { color: t.textSecondary, flex: 1, fontSize: 11 },
    frequencyCount: {
      color: t.textPrimary,
      fontSize: 10.5,
      fontWeight: "700",
      textAlign: "right",
      width: 38,
    },
    frequencyAverage: {
      color: t.textTertiary,
      fontSize: 10,
      textAlign: "right",
      width: 92,
    },
    frequencyTrack: {
      backgroundColor: t.progressTrack,
      borderRadius: 999,
      height: 4,
      marginLeft: 14,
      overflow: "hidden",
    },
    frequencyBar: { borderRadius: 999, height: 4 },
    merchantList: { gap: 13 },
    merchantRow: { gap: 5 },
    merchantTop: { alignItems: "center", flexDirection: "row", gap: 8 },
    merchantRank: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderRadius: 6,
      height: 21,
      justifyContent: "center",
      width: 21,
    },
    merchantRankText: { color: t.textTertiary, fontSize: 9.5, fontWeight: "700" },
    merchantName: { color: t.textSecondary, flex: 1, fontSize: 11.5, fontWeight: "600" },
    merchantAmount: { color: t.textPrimary, fontSize: 11.5, fontWeight: "700" },
    merchantTrack: {
      backgroundColor: t.progressTrack,
      borderRadius: 999,
      height: 6,
      marginLeft: 29,
      overflow: "hidden",
    },
    merchantBar: { backgroundColor: accent.accent, borderRadius: 999, height: 6 },
    merchantMeta: { color: t.textTertiary, fontSize: 9.5, marginLeft: 29, marginTop: -1 },
    insightList: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    insight: {
      backgroundColor: t.cardSurfaceAlt,
      borderRadius: 11,
      flexBasis: 230,
      flexGrow: 1,
      gap: 4,
      minHeight: 76,
      padding: 12,
    },
    insightTop: { alignItems: "center", flexDirection: "row", gap: 7 },
    insightMark: { borderRadius: 999, height: 7, width: 7 },
    insightTitle: { color: t.textPrimary, flex: 1, fontSize: 11.5, fontWeight: "700" },
    insightDetail: { color: t.textTertiary, fontSize: 10.5, lineHeight: 16, paddingLeft: 14 },
    emptyChart: {
      alignItems: "center",
      gap: 6,
      justifyContent: "center",
      minHeight: 190,
      padding: 20,
    },
    emptyTitle: { color: t.textSecondary, fontSize: 12, fontWeight: "600" },
    emptyText: { color: t.textTertiary, fontSize: 10.5, lineHeight: 16, textAlign: "center" },
    loading: { alignItems: "center", flex: 1, gap: 10, justifyContent: "center" },
    loadingText: { color: t.textTertiary, fontSize: 11.5 },
  });
}

type Styles = ReturnType<typeof makeStyles>;

function Delta({ change, styles, theme }: { change: number | null; styles: Styles; theme: Theme }) {
  if (change === null) {
    return <Text style={styles.metricMeta}>同期数据积累中</Text>;
  }
  const up = change > 0;
  const color = up ? theme.t.errorText : theme.t.statusGreenText;
  return (
    <View style={styles.delta}>
      {up ? <RiArrowUpLine color={color} size={11} /> : <RiArrowDownLine color={color} size={11} />}
      <Text style={[styles.metricMeta, { color } as ViewStyle]}>
        较上期{up ? "增加" : "减少"} {Math.abs(change).toFixed(0)}%
      </Text>
    </View>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  meta,
  delta,
  styles,
  accent,
  theme,
}: {
  icon: typeof RiFundsLine;
  label: string;
  value: string;
  meta?: string;
  delta?: number | null;
  styles: Styles;
  accent: Accent;
  theme: Theme;
}) {
  return (
    <View style={styles.metricCard}>
      <View style={styles.metricTop}>
        <View style={styles.metricIcon}>
          <Icon color={accent.accentText} size={14} />
        </View>
        <Text style={styles.metricLabel}>{label}</Text>
      </View>
      <Text numberOfLines={1} style={styles.metricValue}>
        {value}
      </Text>
      {delta !== undefined ? <Delta change={delta} styles={styles} theme={theme} /> : null}
      {meta ? <Text style={styles.metricMeta}>{meta}</Text> : null}
    </View>
  );
}

function TrendChart({
  currency,
  points,
  accent,
  theme,
  styles,
}: {
  currency: string;
  points: TrendPoint[];
  accent: Accent;
  theme: Theme;
  styles: Styles;
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const width = 760;
  const height = 226;
  const left = 54;
  const right = 14;
  const top = 22;
  const bottom = 34;
  const chartHeight = height - top - bottom;
  const chartWidth = width - left - right;
  const maximum = Math.max(1, ...points.map((point) => point.value));
  const slot = chartWidth / Math.max(1, points.length);
  const barWidth = Math.min(38, Math.max(10, slot * 0.56));
  const hasData = points.some((point) => point.value > 0);
  const labelEvery = points.length > 10 ? 2 : 1;
  const gradientId = `finance-bars-${currency.replace(/[^a-z0-9]/gi, "")}`;
  const activeIndex = hoveredIndex ?? -1;
  const hoveredPoint = points[activeIndex] ?? null;
  const hoveredGeometry = hoveredPoint
    ? (() => {
        const x = left + activeIndex * slot + slot / 2;
        const barHeight = (hoveredPoint.value / maximum) * chartHeight;
        const barTop = top + chartHeight - barHeight;
        const estimateWidth = (value: string, fontSize: number) =>
          [...value].reduce(
            (sum, character) =>
              sum + ((character.codePointAt(0) ?? 0) > 127 ? fontSize : fontSize * 0.56),
            0,
          );
        const amountLabel = formatMoney(hoveredPoint.value, currency);
        const tooltipWidth = Math.min(
          210,
          Math.max(
            92,
            Math.ceil(
              Math.max(estimateWidth(hoveredPoint.longLabel, 9.5), estimateWidth(amountLabel, 13)) +
                22,
            ),
          ),
        );
        const tooltipHeight = 45;
        return {
          x: Math.min(width - right - tooltipWidth, Math.max(left, x - tooltipWidth / 2)),
          y: barTop < top + tooltipHeight + 10 ? barTop + 10 : barTop - tooltipHeight - 8,
          width: tooltipWidth,
          height: tooltipHeight,
        };
      })()
    : null;

  if (!hasData) {
    return (
      <View style={styles.emptyChart}>
        <RiBarChart2Line color={theme.t.textTertiary} size={24} />
        <Text style={styles.emptyTitle}>还没有可画出的消费趋势</Text>
        <Text style={styles.emptyText}>记下几笔消费后，这里会自动生成每日、每周和每月的变化。</Text>
      </View>
    );
  }

  return (
    <svg
      aria-label={`消费趋势柱状图，共 ${points.length} 个时间段`}
      onMouseLeave={() => setHoveredIndex(null)}
      role="img"
      style={{ display: "block", height: "auto", maxHeight: 260, width: "100%" }}
      viewBox={`0 0 ${width} ${height}`}
    >
      <title>消费趋势</title>
      <desc>柱子的高度表示每个时间段的消费金额。</desc>
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={accent.accent} />
          <stop offset="100%" stopColor={accent.accentText} stopOpacity="0.62" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
        const y = top + chartHeight * ratio;
        const value = maximum * (1 - ratio);
        return (
          <g key={ratio}>
            <line
              stroke={theme.t.separator}
              strokeWidth="1"
              x1={left}
              x2={width - right}
              y1={y}
              y2={y}
            />
            <text
              fill={theme.t.textTertiary}
              fontSize="9.5"
              textAnchor="end"
              x={left - 8}
              y={y + 3}
            >
              {value === 0 ? "0" : formatMoney(value, currency)}
            </text>
          </g>
        );
      })}
      {points.map((point, index) => {
        const x = left + index * slot + (slot - barWidth) / 2;
        const barHeight = (point.value / maximum) * chartHeight;
        const y = top + chartHeight - barHeight;
        const labelVisible = index % labelEvery === 0 || index === points.length - 1;
        return (
          <g key={point.key}>
            <rect
              fill={`url(#${gradientId})`}
              height={Math.max(point.value > 0 ? 2 : 0, barHeight)}
              opacity={index === points.length - 1 ? 1 : 0.78}
              rx={Math.min(6, barWidth / 2)}
              width={barWidth}
              x={x}
              y={point.value > 0 ? y : top + chartHeight}
            />
            <rect
              aria-label={`${point.longLabel}：${formatMoney(point.value, currency)}`}
              fill="transparent"
              height={chartHeight}
              onBlur={() => setHoveredIndex(null)}
              onFocus={() => setHoveredIndex(index)}
              onMouseEnter={() => setHoveredIndex(index)}
              style={{ cursor: "default", outline: "none" }}
              tabIndex={0}
              width={slot}
              x={left + index * slot}
              y={top}
            />
            {labelVisible ? (
              <text
                fill={theme.t.textTertiary}
                fontSize="9.5"
                textAnchor="middle"
                x={x + barWidth / 2}
                y={height - 12}
              >
                {point.label}
              </text>
            ) : null}
          </g>
        );
      })}
      {hoveredPoint && hoveredGeometry ? (
        <g pointerEvents="none">
          <rect
            fill={theme.t.cardSurface}
            height={hoveredGeometry.height}
            rx="8"
            stroke={theme.t.separatorStrong}
            strokeWidth="1"
            width={hoveredGeometry.width}
            x={hoveredGeometry.x}
            y={hoveredGeometry.y}
          />
          <text
            fill={theme.t.textTertiary}
            fontSize="9.5"
            x={hoveredGeometry.x + 11}
            y={hoveredGeometry.y + 17}
          >
            {hoveredPoint.longLabel}
          </text>
          <text
            fill={accent.accentText}
            fontSize="13"
            fontWeight="700"
            x={hoveredGeometry.x + 11}
            y={hoveredGeometry.y + 35}
          >
            {formatMoney(hoveredPoint.value, currency)}
          </text>
        </g>
      ) : null}
    </svg>
  );
}

function DonutChart({
  categories,
  currency,
  styles,
  theme,
}: {
  categories: CategorySpend[];
  currency: string;
  styles: Styles;
  theme: Theme;
}) {
  const total = categories.reduce((sum, item) => sum + item.amount, 0);
  const visible = categories.slice(0, 5);
  if (categories.length > 5) {
    const rest = categories.slice(5);
    const amount = rest.reduce((sum, item) => sum + item.amount, 0);
    const count = rest.reduce((sum, item) => sum + item.count, 0);
    visible.push({
      name: "其他类别",
      amount,
      count,
      share: total > 0 ? amount / total : 0,
      color: theme.t.textTertiary,
    });
  }
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const segments = visible.map((item, index) => ({
    item,
    offset:
      visible.slice(0, index).reduce((sum, previous) => sum + previous.share, 0) * circumference,
  }));

  if (!total) {
    return (
      <View style={styles.emptyChart}>
        <RiPieChartLine color={theme.t.textTertiary} size={24} />
        <Text style={styles.emptyTitle}>本月还没有消费分类</Text>
        <Text style={styles.emptyText}>分类占比会随着账目自动更新。</Text>
      </View>
    );
  }

  return (
    <View style={styles.donutBody}>
      <svg
        aria-label="本月消费类别占比环形图"
        role="img"
        style={{ display: "block", flex: "0 0 150px", height: 150, width: 150 }}
        viewBox="0 0 150 150"
      >
        <title>本月消费类别占比</title>
        <circle
          cx="75"
          cy="75"
          fill="none"
          r={radius}
          stroke={theme.t.progressTrack}
          strokeWidth="15"
        />
        {segments.map(({ item, offset }) => {
          const length = Math.max(0, item.share * circumference - 2.5);
          return (
            <circle
              cx="75"
              cy="75"
              fill="none"
              key={item.name}
              r={radius}
              stroke={item.color}
              strokeDasharray={`${length} ${circumference - length}`}
              strokeDashoffset={-offset}
              strokeLinecap="round"
              strokeWidth="15"
              transform="rotate(-90 75 75)"
            >
              <title>{`${item.name}：${formatMoney(item.amount, currency)}，${(
                item.share * 100
              ).toFixed(0)}%`}</title>
            </circle>
          );
        })}
        <text fill={theme.t.textTertiary} fontSize="9.5" textAnchor="middle" x="75" y="69">
          本月支出
        </text>
        <text
          fill={theme.t.textPrimary}
          fontSize="14"
          fontWeight="700"
          textAnchor="middle"
          x="75"
          y="88"
        >
          {formatMoney(total, currency)}
        </text>
      </svg>
      <View style={styles.donutLegend}>
        {visible.map((item) => (
          <View key={item.name} style={styles.legendRow}>
            <View style={[styles.legendDot, { backgroundColor: item.color } as ViewStyle]} />
            <Text numberOfLines={1} style={styles.legendName}>
              {item.name}
            </Text>
            <Text style={styles.legendAmount}>{formatMoney(item.amount, currency)}</Text>
            <Text style={styles.legendShare}>{(item.share * 100).toFixed(0)}%</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function MerchantList({
  merchants,
  currency,
  styles,
  theme,
}: {
  merchants: RankedSpend[];
  currency: string;
  styles: Styles;
  theme: Theme;
}) {
  const visible = merchants.slice(0, 6);
  const maximum = Math.max(1, ...visible.map((item) => item.amount));
  if (!visible.length) {
    return (
      <View style={styles.emptyChart}>
        <RiStore2Line color={theme.t.textTertiary} size={24} />
        <Text style={styles.emptyTitle}>本月还没有商家排行</Text>
        <Text style={styles.emptyText}>同一商家的记录会自动归并统计。</Text>
      </View>
    );
  }
  return (
    <View style={styles.merchantList}>
      {visible.map((item, index) => (
        <View key={item.name} style={styles.merchantRow}>
          <View style={styles.merchantTop}>
            <View style={styles.merchantRank}>
              <Text style={styles.merchantRankText}>{index + 1}</Text>
            </View>
            <Text numberOfLines={1} style={styles.merchantName}>
              {item.name}
            </Text>
            <Text style={styles.merchantAmount}>{formatMoney(item.amount, currency)}</Text>
          </View>
          <View style={styles.merchantTrack}>
            <View
              style={[
                styles.merchantBar,
                {
                  opacity: Math.max(0.45, 1 - index * 0.1),
                  width: `${(item.amount / maximum) * 100}%`,
                } as ViewStyle,
              ]}
            />
          </View>
          <Text style={styles.merchantMeta}>
            本月 {item.count} 笔 · 占比 {(item.share * 100).toFixed(0)}%
          </Text>
        </View>
      ))}
    </View>
  );
}

function CategoryFrequency({
  categories,
  currency,
  styles,
  accent,
}: {
  categories: CategorySpend[];
  currency: string;
  styles: Styles;
  accent: Accent;
}) {
  const visible = [...categories]
    .sort((left, right) => right.count - left.count || right.amount - left.amount)
    .slice(0, 6);
  const maximum = Math.max(1, ...visible.map((item) => item.count));

  if (!visible.length) {
    return null;
  }

  return (
    <View style={styles.frequency}>
      <View style={styles.sectionTitleWrap}>
        <RiBarChartHorizontalLine color={accent.accentText} size={15} />
        <Text style={styles.sectionTitle}>消费频次</Text>
      </View>
      <View style={styles.frequencyList}>
        {visible.map((item) => (
          <View key={item.name} style={styles.frequencyRow}>
            <View style={styles.frequencyTop}>
              <View style={[styles.frequencyDot, { backgroundColor: item.color } as ViewStyle]} />
              <Text numberOfLines={1} style={styles.frequencyName}>
                {item.name}
              </Text>
              <Text style={styles.frequencyCount}>{item.count} 笔</Text>
              <Text style={styles.frequencyAverage}>
                笔均 {formatMoney(item.amount / item.count, currency)}
              </Text>
            </View>
            <View style={styles.frequencyTrack}>
              <View
                style={[
                  styles.frequencyBar,
                  {
                    backgroundColor: item.color,
                    opacity: 0.78,
                    width: `${(item.count / maximum) * 100}%`,
                  } as ViewStyle,
                ]}
              />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

function Insights({
  insights,
  styles,
  accent,
  theme,
}: {
  insights: StatisticInsight[];
  styles: Styles;
  accent: Accent;
  theme: Theme;
}) {
  const colors: Record<StatisticInsight["tone"], string> = {
    accent: accent.accent,
    good: theme.t.statusGreenText,
    neutral: theme.t.textTertiary,
    warning: theme.t.errorText,
  };
  return (
    <View style={styles.insightList}>
      {insights.map((insight) => (
        <View key={insight.title} style={styles.insight}>
          <View style={styles.insightTop}>
            <View
              style={[styles.insightMark, { backgroundColor: colors[insight.tone] } as ViewStyle]}
            />
            <Text style={styles.insightTitle}>{insight.title}</Text>
          </View>
          <Text style={styles.insightDetail}>{insight.detail}</Text>
        </View>
      ))}
    </View>
  );
}

export function StatisticsView({
  accent,
  loading,
  preferredCurrency,
  records,
}: {
  accent: Accent;
  loading: boolean;
  preferredCurrency: string;
  records: ExpenseRecord[];
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const currencies = useMemo(
    () => availableCurrencies(records, preferredCurrency),
    [records, preferredCurrency],
  );
  // Remember the display currency the user last picked (a UI preference), so it
  // isn't reset to the default every time the statistics view is reopened.
  const [currency, setCurrency] = useState(() => {
    try {
      const saved = window.localStorage.getItem(DISPLAY_CURRENCY_KEY);
      if (saved) return saved.toUpperCase();
    } catch {
      /* localStorage unavailable — fall back to the preferred currency */
    }
    return preferredCurrency.toUpperCase();
  });
  const changeCurrency = (next: string) => {
    setCurrency(next);
    try {
      window.localStorage.setItem(DISPLAY_CURRENCY_KEY, next);
    } catch {
      /* ignore persistence failures */
    }
  };
  const [range, setRange] = useState<TrendRange>("day");
  const [rateState, setRateState] = useState<{
    key: string;
    snapshot: ExchangeRateSnapshot | null;
    error: string | null;
  }>({ key: "", snapshot: null, error: null });
  const selectedCurrency = currencies.includes(currency)
    ? currency
    : (currencies[0] ?? preferredCurrency.toUpperCase());
  const rateKey = useMemo(
    () =>
      [
        ...new Set([
          ...currencies,
          ...records
            .filter((record) => record.direction === "expense")
            .map((record) => normalizeCurrencyCode(record.currency)),
        ]),
      ]
        .sort()
        .join(","),
    [currencies, records],
  );

  useEffect(() => {
    let cancelled = false;
    void loadExchangeRates(rateKey.split(",").filter(Boolean))
      .then((snapshot) => {
        if (!cancelled) {
          setRateState({ key: rateKey, snapshot, error: null });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRateState({ key: rateKey, snapshot: null, error: String(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rateKey]);

  const rateLoading = rateState.key !== rateKey;
  const activeRates = rateLoading ? null : rateState.snapshot;
  const converted = useMemo(
    () => convertRecords(records, selectedCurrency, activeRates),
    [activeRates, records, selectedCurrency],
  );

  const statistics = useMemo(
    () =>
      buildFinanceStatistics(
        converted.records,
        selectedCurrency,
        todayKey(),
        (category) => categoryStyle(category).color,
      ),
    [converted.records, selectedCurrency],
  );

  if (loading && records.length === 0) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={accent.accentText} size="small" />
        <Text style={styles.loadingText}>正在计算消费统计...</Text>
      </View>
    );
  }

  const currencySelectStyle: CSSProperties = {
    appearance: "none",
    background: "transparent",
    border: 0,
    color: theme.t.textSecondary,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 11,
    fontWeight: 700,
    outline: "none",
    padding: 0,
  };

  return (
    <ScrollView contentContainerStyle={styles.scrollContent} style={styles.scroll}>
      <View style={styles.content}>
        <View style={styles.intro}>
          <View style={styles.introText}>
            <Text style={styles.eyebrow}>智能消费统计</Text>
            <Text style={styles.heading}>消费全景</Text>
          </View>
          <View style={styles.currencyWrap}>
            <select
              aria-label={`统计币种${activeRates ? `，参考汇率日期 ${activeRates.date}` : ""}`}
              onChange={(event) => changeCurrency(event.target.value)}
              style={currencySelectStyle}
              title={
                activeRates
                  ? `${activeRates.date} 参考汇率${activeRates.stale ? "（离线缓存）" : ""}`
                  : "正在获取参考汇率"
              }
              value={selectedCurrency}
            >
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            {rateLoading ? (
              <View style={styles.currencySpinner}>
                <ActivityIndicator color={accent.accentText} size="small" />
              </View>
            ) : null}
          </View>
        </View>

        {!rateLoading && rateState.error && converted.missingCurrencies.length > 0 ? (
          <View style={styles.rateWarning}>
            <Text style={styles.rateWarningText}>
              暂时无法获取参考汇率，当前没有换算
              {converted.missingCurrencies.join("、")} 的账目。
            </Text>
          </View>
        ) : null}

        <View style={styles.metricGrid}>
          <MetricCard
            accent={accent}
            icon={RiCalendarCheckLine}
            label="今天"
            meta={`账本累计 ${statistics.transactionCount} 笔 ${selectedCurrency} 支出`}
            styles={styles}
            theme={theme}
            value={formatMoney(statistics.today, selectedCurrency)}
          />
          <MetricCard
            accent={accent}
            delta={statistics.weekChange}
            icon={RiBarChart2Line}
            label="本周"
            styles={styles}
            theme={theme}
            value={formatMoney(statistics.week, selectedCurrency)}
          />
          <MetricCard
            accent={accent}
            delta={statistics.monthChange}
            icon={RiFundsLine}
            label="本月"
            styles={styles}
            theme={theme}
            value={formatMoney(statistics.month, selectedCurrency)}
          />
          <MetricCard
            accent={accent}
            icon={RiPieChartLine}
            label="近30天日均"
            meta={`本月共 ${statistics.monthTransactionCount} 笔 · ${statistics.noSpendDays} 天零消费`}
            styles={styles}
            theme={theme}
            value={formatMoney(statistics.dailyAverage, selectedCurrency)}
          />
        </View>

        <View style={styles.prediction}>
          <View style={styles.predictionGlow} />
          <View style={styles.sectionHeadingRow}>
            <View>
              <View style={styles.sectionTitleWrap}>
                <RiMagicLine color={accent.accentText} size={16} />
                <Text style={styles.sectionTitle}>智能消费预测</Text>
              </View>
            </View>
            <Text style={styles.confidence}>可信度 {statistics.forecastConfidence}</Text>
          </View>
          <View style={styles.forecastGrid}>
            <View style={styles.forecastItem}>
              <Text style={styles.forecastLabel}>明天预计</Text>
              <Text style={styles.forecastValue}>
                {formatMoney(statistics.tomorrowForecast, selectedCurrency)}
              </Text>
            </View>
            <View style={styles.forecastItem}>
              <Text style={styles.forecastLabel}>本周预计总支出</Text>
              <Text style={styles.forecastValue}>
                {formatMoney(statistics.weekForecast, selectedCurrency)}
              </Text>
            </View>
            <View style={styles.forecastItem}>
              <Text style={styles.forecastLabel}>本月预计总支出</Text>
              <Text style={styles.forecastValue}>
                {formatMoney(statistics.monthForecast, selectedCurrency)}
              </Text>
            </View>
          </View>
          <Text style={styles.forecastNote}>
            根据近 8 周同星期的消费习惯与近 14 天日均动态估算；历史越完整，预测越稳定。
          </Text>
        </View>

        <View style={[styles.panel, styles.trendPanel]}>
          <View style={styles.sectionHeadingRow}>
            <View>
              <View style={styles.sectionTitleWrap}>
                <RiBarChart2Line color={accent.accentText} size={16} />
                <Text style={styles.sectionTitle}>消费趋势</Text>
              </View>
              <Text style={styles.sectionCaption}>最近 14 天 / 10 周 / 10 个月</Text>
            </View>
            <View style={styles.rangeControl}>
              {(Object.keys(RANGE_LABELS) as TrendRange[]).map((item) => (
                <Pressable
                  accessibilityRole="button"
                  key={item}
                  onPress={() => setRange(item)}
                  style={({ hovered }: PressState) => [
                    styles.rangeButton,
                    motion,
                    range === item && styles.rangeButtonActive,
                    hovered && range !== item && styles.rangeButtonHover,
                  ]}
                >
                  <Text style={[styles.rangeText, range === item && styles.rangeTextActive]}>
                    {RANGE_LABELS[item]}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <TrendChart
            accent={accent}
            currency={selectedCurrency}
            points={statistics.trends[range]}
            styles={styles}
            theme={theme}
          />
        </View>

        <View style={styles.splitRow}>
          <View style={[styles.panel, styles.splitPanel]}>
            <View>
              <View style={styles.sectionTitleWrap}>
                <RiPieChartLine color={accent.accentText} size={16} />
                <Text style={styles.sectionTitle}>本月分类分布</Text>
              </View>
            </View>
            <DonutChart
              categories={statistics.categories}
              currency={selectedCurrency}
              styles={styles}
              theme={theme}
            />
            <CategoryFrequency
              accent={accent}
              categories={statistics.categories}
              currency={selectedCurrency}
              styles={styles}
            />
          </View>

          <View style={[styles.panel, styles.splitPanel]}>
            <View>
              <View style={styles.sectionTitleWrap}>
                <RiStore2Line color={accent.accentText} size={16} />
                <Text style={styles.sectionTitle}>商家支出排行</Text>
              </View>
            </View>
            <MerchantList
              currency={selectedCurrency}
              merchants={statistics.merchants}
              styles={styles}
              theme={theme}
            />
          </View>
        </View>

        <View style={styles.panel}>
          <View>
            <View style={styles.sectionTitleWrap}>
              <RiMagicLine color={accent.accentText} size={16} />
              <Text style={styles.sectionTitle}>智能洞察</Text>
            </View>
            <Text style={styles.sectionCaption}>从趋势里直接提炼值得注意的变化</Text>
          </View>
          <Insights accent={accent} insights={statistics.insights} styles={styles} theme={theme} />
        </View>
      </View>
    </ScrollView>
  );
}
