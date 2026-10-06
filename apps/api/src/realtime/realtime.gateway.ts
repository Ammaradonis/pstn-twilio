import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

import { PrismaService } from '../prisma/prisma.service';

interface AuthedSocket extends Socket {
  data: { userId?: string };
}

@WebSocketGateway({
  cors: { origin: true, credentials: true },
  transports: ['websocket', 'polling'],
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: AuthedSocket): Promise<void> {
    const token = this.extractToken(client);
    if (!token) {
      this.logger.debug(`Rejecting unauthenticated socket ${client.id}`);
      client.emit('auth.error', { message: 'Missing auth token' });
      client.disconnect(true);
      return;
    }
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; role?: string }>(token);
      client.data.userId = payload.sub;
      await client.join(userRoom(payload.sub));
      // Owners see every number, so they get every number's events.
      if (await this.isOwner(payload)) await client.join(OWNERS_ROOM);
      this.logger.debug(`Socket ${client.id} authenticated for user ${payload.sub}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      this.logger.debug(`Socket ${client.id} auth failed: ${message}`);
      client.emit('auth.error', { message: 'Invalid token' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: AuthedSocket): void {
    this.logger.debug(`Socket ${client.id} disconnected`);
  }

  emit(event: string, payload: unknown): void {
    if (!this.server) return;
    this.server.emit(event, payload);
  }

  /** Only to the given user's sockets. */
  emitToUser(userId: string, event: string, payload: unknown): void {
    if (!this.server) return;
    this.server.to(userRoom(userId)).emit(event, payload);
  }

  /** To owners and, when given, the user a number belongs to. */
  emitToOwnersAnd(userId: string | null, event: string, payload: unknown): void {
    if (!this.server) return;
    this.server.to(userId ? [OWNERS_ROOM, userRoom(userId)] : OWNERS_ROOM).emit(event, payload);
  }

  private async isOwner(payload: { sub: string; role?: string }): Promise<boolean> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { role: true },
      });
      if (user) return user.role === 'OWNER';
    } catch {
      // Database unavailable: trust the signed token's role.
    }
    return payload.role === 'OWNER';
  }

  private extractToken(client: Socket): string | null {
    const auth = client.handshake.auth?.token;
    if (typeof auth === 'string' && auth.length > 0) return auth;
    const header = client.handshake.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length);
    }
    const query = client.handshake.query?.token;
    if (typeof query === 'string' && query.length > 0) return query;
    return null;
  }
}

const OWNERS_ROOM = 'owners';

function userRoom(userId: string): string {
  return `user:${userId}`;
}
