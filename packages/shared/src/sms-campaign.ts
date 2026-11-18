// Renders the SMS campaign text the same way in the page preview and on the
// server, and sizes it the way carriers bill it.

// GSM 03.38: the default alphabet costs one unit, the extension table two.
// Anything outside both switches the whole text to UCS-2 (70 per segment).
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const GSM_EXTENDED = new Set('^{}\\[~]|€\f');

export interface SmsSize {
  encoding: 'GSM-7' | 'UCS-2';
  /** Billed units: GSM-7 septets, or UTF-16 code units for UCS-2. */
  characters: number;
  /** How many SMS the carrier bills (a long text is split and joined back). */
  segments: number;
}

export function smsSize(text: string): SmsSize {
  let units = 0;
  for (const ch of text) {
    if (GSM_BASIC.has(ch)) units += 1;
    else if (GSM_EXTENDED.has(ch)) units += 2;
    else {
      const length = text.length;
      return {
        encoding: 'UCS-2',
        characters: length,
        segments: length <= 70 ? 1 : Math.ceil(length / 67),
      };
    }
  }
  return {
    encoding: 'GSM-7',
    characters: units,
    segments: units <= 160 ? 1 : Math.ceil(units / 153),
  };
}

const VARIABLE_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const SCHOOL_NAME_RE = /\{\{\s*school_name\s*\}\}/g;

/** Variables in the text other than {{school_name}}, which nothing would fill. */
export function unknownCampaignVariables(template: string): string[] {
  return [...template.matchAll(VARIABLE_RE)]
    .map((match) => match[1] ?? '')
    .filter((name) => name !== 'school_name');
}

/**
 * The school's name as it should read in a text: Google's area suffix
 * dropped ("Seeds 13 Jiu-Jitsu Academy - Abilene, TX"), curly quotes and
 * dashes made plain, and anything outside the GSM alphabet removed, so one
 * symbol can't triple the text's size. Null when nothing usable is left.
 */
export function campaignSchoolName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let name = raw
    .replace(/[\u00AE\u2122\u00A9]/g, '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u2018\u2019\u02BC\u2032]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/["\u201C\u201D]/g, '');
  name = name.split(/\s+[-|]\s+/)[0] ?? '';
  name = [...name].filter((ch) => GSM_BASIC.has(ch) && ch !== '\n' && ch !== '\r').join('');
  name = name
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s,.;:]+$/, '');
  return name.length >= 2 ? name : null;
}

/** The text one lead gets. A lead without a usable name gets "there". */
export function renderCampaignText(
  template: string,
  schoolName: string | null | undefined,
): string {
  const name = campaignSchoolName(schoolName) ?? 'there';
  return template.replace(SCHOOL_NAME_RE, () => name);
}
