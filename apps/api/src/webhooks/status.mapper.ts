import { MessageStatus } from '@prisma/client';

export function mapTwilioStatusToEnum(raw: string): MessageStatus {
  switch (raw.toLowerCase()) {
    case 'received':
      return MessageStatus.RECEIVED;
    case 'queued':
    case 'accepted':
    case 'scheduled':
    case 'sending':
      return MessageStatus.QUEUED;
    case 'sent':
      return MessageStatus.SENT;
    case 'delivered':
      return MessageStatus.DELIVERED;
    case 'undelivered':
      return MessageStatus.UNDELIVERED;
    case 'failed':
    case 'canceled':
      return MessageStatus.FAILED;
    default:
      return MessageStatus.QUEUED;
  }
}
