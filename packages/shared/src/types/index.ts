export type UserRole = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

export type NumberType = 'LOCAL' | 'MOBILE' | 'TOLL_FREE' | 'UNKNOWN';

export type WhatsAppCompatibilityStatus =
  | 'UNKNOWN'
  | 'NOT_GUARANTEED'
  | 'USER_TESTING'
  | 'UNSUPPORTED'
  | 'APPROVED_BUSINESS_SENDER';

export type CallDirection = 'INBOUND' | 'OUTBOUND';

export type CallStatus =
  | 'INITIATED'
  | 'RINGING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'BUSY'
  | 'FAILED'
  | 'NO_ANSWER'
  | 'CANCELED';

export type MessageDirection = 'INBOUND' | 'OUTBOUND';

export type MessageStatus = 'RECEIVED' | 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED' | 'UNDELIVERED';

export interface PhoneNumberCapabilities {
  voice: boolean;
  sms: boolean;
  mms: boolean;
  fax?: boolean;
}
