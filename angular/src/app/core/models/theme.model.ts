export interface ThemeConfig {
  id: string;
  colors: {
    primary:   string;
    secondary: string;
    accent:    string;
    text:      string;
    success:   string;
    warning:   string;
    danger:    string;
  };
  font: {
    primary:   string;
    secondary: string;
  };
  layout: 'spread' | 'stacked' | 'dashboard' | 'tiktok-cover';
  speedUpdateIntervalMs: number;
  gForceBehavior: 'instant' | 'max-hold';
  map: {
    backgroundAlpha: number;
    strokeWidth: number;
    showGrid: boolean;
  };
}

export const VERGARA_YOUTUBE: ThemeConfig = {
  id: 'vergara-youtube',
  colors: {
    primary:   '#00FFFF',
    secondary: '#ec33e9',
    accent:    '#465c85',
    text:      '#00FFFF',
    success:   '#00FF00',
    warning:   '#8c7221',
    danger:    '#FF0000',
  },
  font: {
    primary:   'Consolas, "Courier New", monospace',
    secondary: 'Consolas, "Courier New", monospace',
  },
  layout: 'spread',
  speedUpdateIntervalMs: 0,
  gForceBehavior: 'instant',
  map: { backgroundAlpha: 0, strokeWidth: 2, showGrid: false },
};

export const CLEAN_SPORT: ThemeConfig = {
  id: 'clean-sport',
  colors: {
    primary:   '#FFFFFF',
    secondary: '#FFFFFF',
    accent:    '#FF6600',
    text:      '#FFFFFF',
    success:   '#00CC44',
    warning:   '#FF6600',
    danger:    '#FF3300',
  },
  font: {
    primary:   'Inter, Roboto, sans-serif',
    secondary: 'Inter, Roboto, sans-serif',
  },
  layout: 'stacked',
  speedUpdateIntervalMs: 250,
  gForceBehavior: 'instant',
  map: { backgroundAlpha: 0, strokeWidth: 2, showGrid: false },
};

export const VERGARA_TIKTOK: ThemeConfig = {
  id: 'vergara-tiktok',
  colors: {
    primary:   '#6095FF',
    secondary: '#ed5454',
    accent:    '#37c89a',
    text:      '#FFFFFF',
    success:   '#37c89a',
    warning:   '#fab700',
    danger:    '#ed5454',
  },
  font: {
    primary:   'Orbitron, sans-serif',
    secondary: 'Audiowide, sans-serif',
  },
  layout: 'tiktok-cover',
  speedUpdateIntervalMs: 0,
  gForceBehavior: 'max-hold',
  map: { backgroundAlpha: 1.0, strokeWidth: 2, showGrid: false },
};

export const ALL_THEMES: ThemeConfig[] = [VERGARA_YOUTUBE, CLEAN_SPORT, VERGARA_TIKTOK];
