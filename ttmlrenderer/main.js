import { initUI } from './modules/ui.js';
import { initPreview } from './modules/preview.js';

/**
 * TTML Renderer - Application Entry Point
 * v5.1.0 (Modular Refactor)
 */

document.addEventListener('DOMContentLoaded', () => {
  // Initialize the UI and event listeners
  initUI();
  
  // Initialize the rendering preview system
  initPreview('render-preview');
  
  console.log('TTML Renderer v5.1.0 initialized');
});