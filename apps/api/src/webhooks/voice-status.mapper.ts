import { CallStatus } from '@prisma/client';

export function mapTwilioCallStatus(raw: string): CallStatus {
  switch (raw.toLowerCase()) {
    case 'initiated':
      return CallStatus.INITIATED;
    case 'ringing':
      return CallStatus.RINGING;
    case 'in-progress':
    case 'answered':
      return CallStatus.IN_PROGRESS;
    case 'completed':
      return CallStatus.COMPLETED;
    case 'busy':
      return CallStatus.BUSY;
    case 'failed':
      return CallStatus.FAILED;
    case 'no-answer':
      return CallStatus.NO_ANSWER;
    case 'canceled':
      return CallStatus.CANCELED;
    default:
      return CallStatus.INITIATED;
  }
}
