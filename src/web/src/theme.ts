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
    colorBgBase: '#1a1a1d',
    colorBgContainer: '#232327',
    colorBgElevated: '#2b2b2f',
    colorText: '#ced2d9',
    colorTextSecondary: '#a6acb4',
    colorTextTertiary: '#888d95',
    colorBorder: '#38383d',
    colorBorderSecondary: '#2b2b2f',
    borderRadius: 6,
    controlHeight: 32,
    fontFamily,
  },
  components: {
    Layout: {
      siderBg: '#232327',
      bodyBg: '#1a1a1d',
      headerBg: '#232327',
    },
    Menu: {
      itemSelectedBg: 'rgba(91, 140, 255, 0.16)',
      itemSelectedColor: '#5b8cff',
      itemHoverBg: '#2b2b2f',
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
      itemSelectedBg: '#38383d',
      trackBg: '#2b2b2f',
    },
    Table: {
      headerBg: '#232327',
      rowHoverBg: '#2b2b2f',
      borderColor: '#2b2b2f',
    },
    Modal: {
      borderRadiusLG: 10,
    },
  },
};

// Back-compat alias for existing importers.
export const theme = lightTheme;
