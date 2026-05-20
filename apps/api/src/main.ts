import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { AppModule } from './app.module';

function parseOrigins(value?: string): string[] {
  return (
    value
      ?.split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean) ?? []
  );
}

function corsOrigins(config: ConfigService): string[] {
  return Array.from(
    new Set([
      ...parseOrigins(config.get<string>('CORS_ORIGINS')),
      ...parseOrigins(config.get<string>('WEB_APP_URL')),
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'https://webfitalchemist.online',
      'https://app.webfitalchemist.online',
    ]),
  );
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  app.use(helmet());
  app.use(cookieParser());
  const allowedOrigins = corsOrigins(config);
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin.replace(/\/+$/, ''))) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.setGlobalPrefix('api', {
    exclude: [{ path: 'webhooks/(.*)', method: RequestMethod.ALL }],
  });

  const port = Number(config.get('PORT') ?? 3000);
  await app.listen(port);
  logger.log(`API listening on http://localhost:${port}/api`);
  logger.log(
    `Twilio webhooks expected at ${config.get('TWILIO_WEBHOOK_BASE_URL') ?? config.get('PUBLIC_BASE_URL') ?? '(unset)'}/webhooks/twilio/*`,
  );
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap API:', err);
  process.exit(1);
});
