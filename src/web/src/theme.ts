import { theme as antdTheme, type ThemeConfig } from 'antd';

const fontFamily =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

// Feishu / Lark-inspired light theme. Primary blue #3370FF, neutral greys,
// compact controls and subtle borders.
export const lightTheme: ThemeConfig = {
  token: {
    colorPrimary: '#3370ff',
    colorInfo: '#3370ff',
    colorSuccess: '#2ea121',
    colorError: '#f54a45',
    colorWarning: '#ff8800',
    colorText: '#1f2329',
    colorTextSecondary: '#646a73',
    colorTextTertiary: '#8f959e',
    colorBorder: '#dee0e3',
    colorBorderSecondary: '#eceef1',
    borderRadius: 6,
    controlHeight: 32,
    fontFamily,
  },
  components: {
    Layout: {
      siderBg: '#ffffff',
      bodyBg: '#ffffff',
      headerBg: '#ffffff',
    },
    Menu: {
      itemSelectedBg: '#eaf1ff',
      itemSelectedColor: '#3370ff',
      itemHoverBg: '#f2f3f5',
      itemActiveBg: '#eaf1ff',
      itemHeight: 38,
      itemBorderRadius: 6,
      itemMarginInline: 8,
      iconSize: 16,
    },
    Button: {
      primaryShadow: 'none',
      defaultShadow: 'none',
    },
    Segmented: {
      itemSelectedColor: '#3370ff',
      trackBg: '#f2f3f5',
    },
    Table: {
      headerBg: '#ffffff',
      rowHoverBg: '#f5f6f7',
      borderColor: '#eceef1',
    },
    Modal: {
      borderRadiusLG: 10,
    },
  },
};

// Dark counterpart. AntD's darkAlgorithm derives the full dark palette from the
// seed colours; the explicit neutrals below pin component surfaces to the same
// values index.css uses for its dark tokens, so custom CSS and AntD stay in sync.
export const darkTheme: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    colorPrimary: '#3370ff',
    colorInfo: '#3370ff',
    colorSuccess: '#3fb45b',
    colorError: '#f0837b',
    colorWarning: '#e0a23b',
    colorBgBase: '#202023',
    colorBgContainer: '#2b2b2e',
    colorBgElevated: '#343437',
    colorText: '#c9ced5',
    colorTextSecondary: '#a7adb6',
    colorTextTertiary: '#8b9099',
    colorBorder: '#424246',
    colorBorderSecondary: '#343437',
    borderRadius: 6,
    controlHeight: 32,
    fontFamily,
  },
  components: {
    Layout: {
      siderBg: '#2b2b2e',
      bodyBg: '#202023',
      headerBg: '#2b2b2e',
    },
    Menu: {
      itemSelectedBg: 'rgba(91, 140, 255, 0.16)',
      itemSelectedColor: '#5b8cff',
      itemHoverBg: '#343437',
      itemActiveBg: 'rgba(91, 140, 255, 0.16)',
      itemHeight: 38,
      itemBorderRadius: 6,
      itemMarginInline: 8,
      iconSize: 16,
    },
    Button: {
      primaryShadow: 'none',
      defaultShadow: 'none',
    },
    Segmented: {
      itemSelectedColor: '#5b8cff',
      itemSelectedBg: '#424246',
      trackBg: '#343437',
    },
    Table: {
      headerBg: '#2b2b2e',
      rowHoverBg: '#343437',
      borderColor: '#343437',
    },
    Modal: {
      borderRadiusLG: 10,
    },
  },
};

// Back-compat alias for existing importers.
export const theme = lightTheme;
