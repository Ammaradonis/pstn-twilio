// US states the AI agent can target, with the IANA time zones in use there.
// The first zone is where most of the state's population lives; states split
// across zones list the others so a caller can pick the right one.
//
// `allPartyRecordingConsent` marks states commonly treated as requiring every
// party's consent to record a call. The agent discloses the recording there.
// It is a conservative list, not legal advice.

export interface UsState {
  code: string;
  name: string;
  timeZones: readonly string[];
  allPartyRecordingConsent: boolean;
}

export const US_STATES: readonly UsState[] = [
  { code: 'AL', name: 'Alabama', timeZones: ['America/Chicago'], allPartyRecordingConsent: false },
  {
    code: 'AK',
    name: 'Alaska',
    timeZones: ['America/Anchorage', 'America/Adak'],
    allPartyRecordingConsent: false,
  },
  { code: 'AZ', name: 'Arizona', timeZones: ['America/Phoenix'], allPartyRecordingConsent: false },
  { code: 'AR', name: 'Arkansas', timeZones: ['America/Chicago'], allPartyRecordingConsent: false },
  {
    code: 'CA',
    name: 'California',
    timeZones: ['America/Los_Angeles'],
    allPartyRecordingConsent: true,
  },
  { code: 'CO', name: 'Colorado', timeZones: ['America/Denver'], allPartyRecordingConsent: false },
  {
    code: 'CT',
    name: 'Connecticut',
    timeZones: ['America/New_York'],
    allPartyRecordingConsent: true,
  },
  { code: 'DE', name: 'Delaware', timeZones: ['America/New_York'], allPartyRecordingConsent: true },
  {
    code: 'DC',
    name: 'District of Columbia',
    timeZones: ['America/New_York'],
    allPartyRecordingConsent: false,
  },
  {
    code: 'FL',
    name: 'Florida',
    timeZones: ['America/New_York', 'America/Chicago'],
    allPartyRecordingConsent: true,
  },
  { code: 'GA', name: 'Georgia', timeZones: ['America/New_York'], allPartyRecordingConsent: false },
  { code: 'HI', name: 'Hawaii', timeZones: ['Pacific/Honolulu'], allPartyRecordingConsent: false },
  {
    code: 'ID',
    name: 'Idaho',
    timeZones: ['America/Boise', 'America/Los_Angeles'],
    allPartyRecordingConsent: false,
  },
  { code: 'IL', name: 'Illinois', timeZones: ['America/Chicago'], allPartyRecordingConsent: true },
  {
    code: 'IN',
    name: 'Indiana',
    timeZones: ['America/Indiana/Indianapolis', 'America/Chicago'],
    allPartyRecordingConsent: false,
  },
  { code: 'IA', name: 'Iowa', timeZones: ['America/Chicago'], allPartyRecordingConsent: false },
  {
    code: 'KS',
    name: 'Kansas',
    timeZones: ['America/Chicago', 'America/Denver'],
    allPartyRecordingConsent: false,
  },
  {
    code: 'KY',
    name: 'Kentucky',
    timeZones: ['America/New_York', 'America/Chicago'],
    allPartyRecordingConsent: false,
  },
  {
    code: 'LA',
    name: 'Louisiana',
    timeZones: ['America/Chicago'],
    allPartyRecordingConsent: false,
  },
  { code: 'ME', name: 'Maine', timeZones: ['America/New_York'], allPartyRecordingConsent: false },
  { code: 'MD', name: 'Maryland', timeZones: ['America/New_York'], allPartyRecordingConsent: true },
  {
    code: 'MA',
    name: 'Massachusetts',
    timeZones: ['America/New_York'],
    allPartyRecordingConsent: true,
  },
  {
    code: 'MI',
    name: 'Michigan',
    timeZones: ['America/Detroit', 'America/Menominee'],
    allPartyRecordingConsent: true,
  },
  {
    code: 'MN',
    name: 'Minnesota',
    timeZones: ['America/Chicago'],
    allPartyRecordingConsent: false,
  },
  {
    code: 'MS',
    name: 'Mississippi',
    timeZones: ['America/Chicago'],
    allPartyRecordingConsent: false,
  },
  { code: 'MO', name: 'Missouri', timeZones: ['America/Chicago'], allPartyRecordingConsent: false },
  { code: 'MT', name: 'Montana', timeZones: ['America/Denver'], allPartyRecordingConsent: true },
  {
    code: 'NE',
    name: 'Nebraska',
    timeZones: ['America/Chicago', 'America/Denver'],
    allPartyRecordingConsent: false,
  },
  {
    code: 'NV',
    name: 'Nevada',
    timeZones: ['America/Los_Angeles', 'America/Denver'],
    allPartyRecordingConsent: true,
  },
  {
    code: 'NH',
    name: 'New Hampshire',
    timeZones: ['America/New_York'],
    allPartyRecordingConsent: true,
  },
  {
    code: 'NJ',
    name: 'New Jersey',
    timeZones: ['America/New_York'],
    allPartyRecordingConsent: false,
  },
  {
    code: 'NM',
    name: 'New Mexico',
    timeZones: ['America/Denver'],
    allPartyRecordingConsent: false,
  },
  {
    code: 'NY',
    name: 'New York',
    timeZones: ['America/New_York'],
    allPartyRecordingConsent: false,
  },
  {
    code: 'NC',
    name: 'North Carolina',
    timeZones: ['America/New_York'],
    allPartyRecordingConsent: false,
  },
  {
    code: 'ND',
    name: 'North Dakota',
    timeZones: ['America/Chicago', 'America/Denver'],
    allPartyRecordingConsent: false,
  },
  { code: 'OH', name: 'Ohio', timeZones: ['America/New_York'], allPartyRecordingConsent: false },
  { code: 'OK', name: 'Oklahoma', timeZones: ['America/Chicago'], allPartyRecordingConsent: false },
  {
    code: 'OR',
    name: 'Oregon',
    timeZones: ['America/Los_Angeles', 'America/Boise'],
    allPartyRecordingConsent: true,
  },
  {
    code: 'PA',
    name: 'Pennsylvania',
    timeZones: ['America/New_York'],
    allPartyRecordingConsent: true,
  },
  {
    code: 'RI',
    name: 'Rhode Island',
    timeZones: ['America/New_York'],
    allPartyRecordingConsent: false,
  },
  {
    code: 'SC',
    name: 'South Carolina',
    timeZones: ['America/New_York'],
    allPartyRecordingConsent: false,
  },
  {
    code: 'SD',
    name: 'South Dakota',
    timeZones: ['America/Chicago', 'America/Denver'],
    allPartyRecordingConsent: false,
  },
  {
    code: 'TN',
    name: 'Tennessee',
    timeZones: ['America/Chicago', 'America/New_York'],
    allPartyRecordingConsent: false,
  },
  {
    code: 'TX',
    name: 'Texas',
    timeZones: ['America/Chicago', 'America/Denver'],
    allPartyRecordingConsent: false,
  },
  { code: 'UT', name: 'Utah', timeZones: ['America/Denver'], allPartyRecordingConsent: false },
  { code: 'VT', name: 'Vermont', timeZones: ['America/New_York'], allPartyRecordingConsent: false },
  {
    code: 'VA',
    name: 'Virginia',
    timeZones: ['America/New_York'],
    allPartyRecordingConsent: false,
  },
  {
    code: 'WA',
    name: 'Washington',
    timeZones: ['America/Los_Angeles'],
    allPartyRecordingConsent: true,
  },
  {
    code: 'WV',
    name: 'West Virginia',
    timeZones: ['America/New_York'],
    allPartyRecordingConsent: false,
  },
  {
    code: 'WI',
    name: 'Wisconsin',
    timeZones: ['America/Chicago'],
    allPartyRecordingConsent: false,
  },
  { code: 'WY', name: 'Wyoming', timeZones: ['America/Denver'], allPartyRecordingConsent: false },
];

const STATES_BY_CODE = new Map(US_STATES.map((state) => [state.code, state]));

export function findUsState(code: string | null | undefined): UsState | null {
  if (!code) return null;
  return STATES_BY_CODE.get(code.toUpperCase()) ?? null;
}

const TIME_ZONE_LABELS: Record<string, string> = {
  'America/New_York': 'Eastern Time',
  'America/Detroit': 'Eastern Time',
  'America/Indiana/Indianapolis': 'Eastern Time',
  'America/Chicago': 'Central Time',
  'America/Menominee': 'Central Time',
  'America/Denver': 'Mountain Time',
  'America/Boise': 'Mountain Time',
  'America/Phoenix': 'Arizona Time',
  'America/Los_Angeles': 'Pacific Time',
  'America/Anchorage': 'Alaska Time',
  'America/Adak': 'Hawaii-Aleutian Time',
  'Pacific/Honolulu': 'Hawaii Time',
};

export function timeZoneLabel(timeZone: string): string {
  return TIME_ZONE_LABELS[timeZone] ?? timeZone;
}
