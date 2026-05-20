import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: config.get('CORS_ORIGINS')?.split(',') || ['http://localhost:5173'],
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
