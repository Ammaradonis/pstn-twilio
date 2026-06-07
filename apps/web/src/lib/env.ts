import { z } from 'zod';

const schema = z.object({
  VITE_API_BASE_URL: z.string().min(1).default('/api'),
  VITE_WS_URL: z.string().min(1).default('/'),
  VITE_APP_NAME: z.string().min(1).default('pstn-twilio'),
  VITE_REPEAT_DIAL_WARNING_ENABLED: z.preprocess(
    (value) => value === true || value === 'true',
    z.boolean(),
  ),
});

export const env = schema.parse({
  VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
  VITE_WS_URL: import.meta.env.VITE_WS_URL,
  VITE_APP_NAME: import.meta.env.VITE_APP_NAME,
  VITE_REPEAT_DIAL_WARNING_ENABLED: import.meta.env.VITE_REPEAT_DIAL_WARNING_ENABLED,
});
