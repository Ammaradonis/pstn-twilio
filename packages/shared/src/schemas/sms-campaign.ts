import { z } from 'zod';

import { normalizeDialablePhoneNumber } from '../phone';
import { unknownCampaignVariables } from '../sms-campaign';

export const smsCampaignBodySchema = z
  .string()
  .trim()
  .min(20, 'The text is too short.')
  .max(1000, 'Keep the text under 1000 characters.')
  .superRefine((body, ctx) => {
    if (!/\bSTOP\b/.test(body)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Keep the opt out line in the text: Reply STOP to opt out',
      });
    }
    const unknown = unknownCampaignVariables(body);
    if (unknown.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Only {{school_name}} can be filled in. Remove ${unknown
          .map((name) => `{{${name}}}`)
          .join(', ')}.`,
      });
    }
  });

export const smsCampaignUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    body: smsCampaignBodySchema.optional(),
  })
  .refine((input) => input.enabled !== undefined || input.body !== undefined, {
    message: 'Nothing to update.',
  });

export const smsCampaignTestSchema = z.object({
  // The toll-free line texts US and Canadian numbers only.
  to: z.preprocess(
    (value) => (typeof value === 'string' ? (normalizeDialablePhoneNumber(value) ?? value) : value),
    z.string().regex(/^\+1[2-9]\d{9}$/, 'Enter a US or Canadian number.'),
  ),
});

export type SmsCampaignUpdateInput = z.infer<typeof smsCampaignUpdateSchema>;
export type SmsCampaignTestInput = z.infer<typeof smsCampaignTestSchema>;
