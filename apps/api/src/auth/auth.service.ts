import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import * as argon2 from 'argon2';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private audit: AuditService,
  ) {}

  async login(email: string, password: string, ip?: string, userAgent?: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user?.passwordHash || user.disabledAt) throw new UnauthorizedException();

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) throw new UnauthorizedException();

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await this.audit.log({
      userId: user.id,
      action: 'auth.login',
      entityType: 'User',
      entityId: user.id,
      ipAddress: ip,
      userAgent,
    });

    const token = this.jwt.sign({ sub: user.id, email: user.email, role: user.role });
    return { token, user: { id: user.id, email: user.email, role: user.role } };
  }

  async validateUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.disabledAt) throw new UnauthorizedException();
    return user;
  }

  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
    ip?: string,
    userAgent?: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.passwordHash) throw new UnauthorizedException();

    const valid = await argon2.verify(user.passwordHash, oldPassword);
    if (!valid) throw new UnauthorizedException();

    const passwordHash = await argon2.hash(newPassword);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });

    await this.audit.log({
      userId,
      action: 'auth.password_changed',
      entityType: 'User',
      entityId: userId,
      ipAddress: ip,
      userAgent,
    });
  }

  async bootstrapOwner(email: string, password: string, token: string, bootstrapToken: string) {
    if (token !== bootstrapToken) throw new UnauthorizedException();

    const existing = await this.prisma.user.findFirst({ where: { role: UserRole.OWNER } });
    if (existing) throw new UnauthorizedException('Owner already exists');

    const passwordHash = await argon2.hash(password);
    const user = await this.prisma.user.create({
      data: { email, passwordHash, role: UserRole.OWNER },
    });

    await this.audit.log({
      userId: user.id,
      action: 'auth.owner_bootstrapped',
      entityType: 'User',
      entityId: user.id,
    });

    return { id: user.id, email: user.email, role: user.role };
  }
}
