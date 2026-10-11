import { Prisma } from '@prisma/client';

/** Only classify availability failures; query and constraint bugs remain 500s. */
export function databaseUnavailableMessage(error: unknown): string | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) &&
    !(error instanceof Prisma.PrismaClientUnknownRequestError) &&
    !(error instanceof Prisma.PrismaClientInitializationError)
  ) {
    return null;
  }

  if (/\bexceeded (?:the |your )?(?:[\w -]+ )?quota\b/i.test(error.message)) {
    return 'The database usage limit has been reached. The account owner must restore database capacity before the softphone can be used.';
  }

  // Prisma can omit errorCode when an already-created client cannot reconnect.
  if (
    error instanceof Prisma.PrismaClientInitializationError ||
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2037'].includes(error.code))
  ) {
    return 'The database is temporarily unavailable. Please try again shortly.';
  }
  return null;
}
