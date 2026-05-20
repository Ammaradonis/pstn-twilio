import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { type ConfigService } from '@nestjs/config';
import type { UserRole } from '@prisma/client';
import { type Request } from 'express';

import { type AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

type AuthenticatedRequest = Request & {
  user: {
    id: string;
    email: string;
    role: UserRole;
  };
};

@Controller('auth')
export class AuthController {
  constructor(
    private auth: AuthService,
    private config: ConfigService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: { email: string; password: string }, @Req() req: Request) {
    return this.auth.login(body.email, body.password, req.ip, req.headers['user-agent']);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async logout() {
    return { message: 'Logged out' };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: AuthenticatedRequest) {
    return req.user;
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async changePassword(
    @Body() body: { oldPassword: string; newPassword: string },
    @Req() req: AuthenticatedRequest,
  ) {
    await this.auth.changePassword(
      req.user.id,
      body.oldPassword,
      body.newPassword,
      req.ip,
      req.headers['user-agent'],
    );
    return { message: 'Password changed' };
  }

  @Post('bootstrap-owner')
  @HttpCode(201)
  async bootstrapOwner(@Body() body: { email: string; password: string; token: string }) {
    const bootstrapToken = this.config.get('BOOTSTRAP_TOKEN');
    if (!bootstrapToken) throw new Error('Bootstrap disabled');
    return this.auth.bootstrapOwner(body.email, body.password, body.token, bootstrapToken);
  }
}
