export const APP_VERSION = '5.2.0';
export const FILENAME_KEY     = 'ttml-renderer-filename';
export const FILENAME_DEFAULT = '[%EXT% %TYPEU% TTMLRenderer v%VER#%] %AUDIO% (%TIME24%)';
export const EXPORT_QUALITY_KEY  = 'ttml-renderer-export-quality';
export const EXPORT_FORMAT_KEY   = 'ttml-renderer-export-format';
export const RENDER_METHOD_KEY   = 'ttml-renderer-render-method';
export const CUSTOM_QUALITY_W_KEY = 'ttml-renderer-custom-q-w';
export const CUSTOM_QUALITY_H_KEY = 'ttml-renderer-custom-q-h';
export const CUSTOM_QUALITY_FPS_KEY = 'ttml-renderer-custom-q-fps';

export const EXPORT_QUALITY_PROFILES = {
  ultra: {
    width: 1920,
    height: 1080,
    fps: 60,
    videoBitsPerSecond: 15_000_000,
  },
  high: {
    width: 1280,
    height: 720,
    fps: 30,
    videoBitsPerSecond: 8_000_000,
  },
  balanced: {
    width: 960,
    height: 540,
    fps: 30,
    videoBitsPerSecond: 5_000_000,
  },
  performance: {
    width: 854,
    height: 480,
    fps: 24,
    videoBitsPerSecond: 3_200_000,
  },
};

export const OVERLAP_WARNING_MSG =
  'This renderer was not designed to handle files with complex and overlapping timing. ' +
  'If you proceed with rendering this file, the output may show lines out of order, freezing, ' +
  'text jumping, or other unexpected behavior.\n\n' +
  'The Birds-eye View handles complex overlapping timing most reliably. ' +
  'If you want a stable render, it is recommended to use that instead.';

export const EXPORT_FORMAT_DEFAULT = 'webm';

export const THEME_KEY = 'ttml-renderer-theme';
export const DEFAULTS = {
  '--accent':      '#e8f440',
  '--accent2':     '#ff4d6d',
  '--bg':          '#0a0a0f',
  '--surface':     '#111118',
  '--border':      '#1e1e2e',
  '--text-bright': '#c8c8e8',
  '--text-mid':    '#6a6a9a',
  '--text-dim':    '#3a3a55'
};

export const PICKER_MAP = {
  'pick-accent':      '--accent',
  'pick-accent2':     '--accent2',
  'pick-bg':          '--bg',
  'pick-surface':     '--surface',
  'pick-border':      '--border',
  'pick-text-bright': '--text-bright',
  'pick-text-mid':    '--text-mid',
  'pick-text-dim':    '--text-dim'
};
