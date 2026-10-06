/** @type {import('tailwindcss').Config} */
import forms from '@tailwindcss/forms';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          50: '#f5f7fa',
          900: '#0b1220',
        },
        // Voice app palette.
        gv: {
          blue: '#1a73e8',
          'blue-dark': '#1765cc',
          'blue-soft': '#e8f0fe',
          green: '#188038',
          'green-bright': '#1e8e3e',
          red: '#d93025',
          ink: '#202124',
          muted: '#5f6368',
          line: '#dadce0',
          soft: '#f1f3f4',
          surface: '#f8f9fa',
        },
      },
    },
  },
  plugins: [forms],
};
