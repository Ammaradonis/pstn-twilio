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

export function preserveMostFinalMessageStatus(
  current: MessageStatus,
  incoming: MessageStatus,
): MessageStatus {
  return statusRank(incoming) >= statusRank(current) ? incoming : current;
}

export function describeTwilioMessagingError(errorCode: string | null | undefined): string | null {
  switch (errorCode) {
    case '30032':
      return 'The toll-free sender is not verified for messaging. Complete Twilio toll-free verification or send from an approved SMS sender.';
    default:
      return null;
  }
}

function statusRank(status: MessageStatus): number {
  switch (status) {
    case MessageStatus.QUEUED:
      return 0;
    case MessageStatus.SENT:
      return 1;
    case MessageStatus.RECEIVED:
    case MessageStatus.DELIVERED:
      return 2;
    case MessageStatus.UNDELIVERED:
    case MessageStatus.FAILED:
      return 3;
    default:
      return 0;
  }
}
