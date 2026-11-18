import { describe, expect, it } from 'vitest';

import { DEFAULT_SMS_CAMPAIGN_BODY, SMS_CAMPAIGN_LOOM_URL } from './dto/sms-campaign.dto';
import { smsCampaignTestSchema, smsCampaignUpdateSchema } from './schemas/sms-campaign';
import {
  campaignSchoolName,
  renderCampaignText,
  smsSize,
  unknownCampaignVariables,
} from './sms-campaign';

describe('the campaign text', () => {
  it('carries the video, the demo line and the opt out', () => {
    expect(DEFAULT_SMS_CAMPAIGN_BODY).toContain(SMS_CAMPAIGN_LOOM_URL);
    expect(DEFAULT_SMS_CAMPAIGN_BODY).toContain('(667) 220-6726');
    expect(DEFAULT_SMS_CAMPAIGN_BODY).toMatch(/Reply STOP to opt out$/);
    // The link sits on its own line so phones make it tappable.
    expect(DEFAULT_SMS_CAMPAIGN_BODY.split('\n')).toContain(SMS_CAMPAIGN_LOOM_URL);
  });

  it('has no hyphen outside the demo number', () => {
    expect(DEFAULT_SMS_CAMPAIGN_BODY.replace('220-6726', '')).not.toContain('-');
  });

  it('stays plain GSM text at three segments even with a long school name', () => {
    const size = smsSize(renderCampaignText(DEFAULT_SMS_CAMPAIGN_BODY, 'x'.repeat(40)));
    expect(size.encoding).toBe('GSM-7');
    expect(size.segments).toBe(3);
  });

  it('passes the schema', () => {
    expect(smsCampaignUpdateSchema.safeParse({ body: DEFAULT_SMS_CAMPAIGN_BODY }).success).toBe(
      true,
    );
  });
});

describe('campaignSchoolName', () => {
  it.each([
    ['Seeds 13 Jiu-Jitsu Academy - Abilene, TX', 'Seeds 13 Jiu-Jitsu Academy'],
    ['War Room \u2013 Open Gym', 'War Room'],
    ['Kang\u2019s TaeKwonDo Harlingen', "Kang's TaeKwonDo Harlingen"],
    ['ALMMA \u201CAssassins Lair', 'ALMMA Assassins Lair'],
    ['Paradigm\u00AE Combat Sports Training Center', 'Paradigm Combat Sports Training Center'],
    ['\u200BSouth Texas Grappling Team \u200B', 'South Texas Grappling Team'],
    ['Tiger-Rock Martial Arts of Frisco-Legacy', 'Tiger-Rock Martial Arts of Frisco-Legacy'],
    ['Dojo \uD83E\uDD4B Karate', 'Dojo Karate'],
  ])('%s -> %s', (raw, expected) => {
    expect(campaignSchoolName(raw)).toBe(expected);
  });

  it('gives up on empty or symbol-only names', () => {
    expect(campaignSchoolName(null)).toBeNull();
    expect(campaignSchoolName('  ')).toBeNull();
    expect(campaignSchoolName('\uD83E\uDD4B')).toBeNull();
  });
});

describe('renderCampaignText', () => {
  it('fills every {{school_name}}', () => {
    expect(renderCampaignText('Hey {{school_name}}! {{ school_name }}', 'Kicks')).toBe(
      'Hey Kicks! Kicks',
    );
  });

  it('says "there" when the name is unusable', () => {
    expect(renderCampaignText('Hey {{school_name}},', null)).toBe('Hey there,');
  });

  it('keeps a $ in a name as is', () => {
    expect(renderCampaignText('Hey {{school_name}}', "$$ Kicks $&'")).toBe("Hey $$ Kicks $&'");
  });

  it('spots variables nothing fills', () => {
    expect(unknownCampaignVariables('Hi {{school_name}} in {{city}}')).toEqual(['city']);
  });
});

describe('smsSize', () => {
  it('counts GSM text in 160 then 153 character segments', () => {
    expect(smsSize('a'.repeat(160))).toEqual({ encoding: 'GSM-7', characters: 160, segments: 1 });
    expect(smsSize('a'.repeat(161)).segments).toBe(2);
    expect(smsSize('a'.repeat(306)).segments).toBe(2);
    expect(smsSize('a'.repeat(307)).segments).toBe(3);
  });

  it('counts extension characters twice', () => {
    expect(smsSize('{}').characters).toBe(4);
  });

  it('switches to UCS-2 for a curly quote', () => {
    expect(smsSize('it\u2019s')).toEqual({ encoding: 'UCS-2', characters: 4, segments: 1 });
    expect(smsSize('\u2019'.repeat(71)).segments).toBe(2);
  });
});

describe('campaign schemas', () => {
  it('requires the opt out line', () => {
    const result = smsCampaignUpdateSchema.safeParse({
      body: 'Hey {{school_name}}, watch this video',
    });
    expect(result.success).toBe(false);
  });

  it('refuses variables nothing fills', () => {
    const result = smsCampaignUpdateSchema.safeParse({
      body: 'Hey {{first_name}}, watch this. Reply STOP to opt out',
    });
    expect(result.success).toBe(false);
  });

  it('needs something to change', () => {
    expect(smsCampaignUpdateSchema.safeParse({}).success).toBe(false);
    expect(smsCampaignUpdateSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it('takes a US test number in any common format', () => {
    expect(smsCampaignTestSchema.parse({ to: '(512) 555-0123' }).to).toBe('+15125550123');
    expect(smsCampaignTestSchema.safeParse({ to: '+447458904436' }).success).toBe(false);
  });
});
