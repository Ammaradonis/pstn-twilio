import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

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

  constructor(private readonly jwt: JwtService) {}

  async handleConnection(client: AuthedSocket): Promise<void> {
    const token = this.extractToken(client);
    if (!token) {
      this.logger.debug(`Rejecting unauthenticated socket ${client.id}`);
      client.emit('auth.error', { message: 'Missing auth token' });
      client.disconnect(true);
      return;
    }
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token);
      client.data.userId = payload.sub;
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
