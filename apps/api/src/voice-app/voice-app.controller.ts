import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  blockNumberSchema,
  contactImportSchema,
  contactUpsertSchema,
  forwardingCreateSchema,
  forwardingUpdateSchema,
  voiceCallAnsweredSchema,
  voiceDeviceUpsertSchema,
  voiceGreetingUploadSchema,
  voicePhoneNumberSchema,
  voicePushSubscriptionSchema,
  voiceReadMarkerSchema,
  voiceSendMessageSchema,
  voiceSettingsUpdateSchema,
} from '@pstn-twilio/shared';
import type { Response } from 'express';
import { z } from 'zod';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod.pipe';

import { VoiceAppCallsService } from './voice-app-calls.service';
import { VoiceAppContactsService } from './voice-app-contacts.service';
import { VoiceAppDevicesService } from './voice-app-devices.service';
import { VoiceAppSettingsService } from './voice-app-settings.service';
import { VoiceExperienceGuard, voiceActor, type VoiceActorRequest } from './voice-app.context';
import { VoiceAppService } from './voice-app.service';
import { VoicePushService } from './voice-push.service';

const pageSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const callsQuerySchema = pageSchema.extend({
  filter: z.enum(['all', 'missed']).default('all'),
});
const callSidSchema = z.string().regex(/^CA[0-9a-f]{32}$/);
const deviceIdSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);
const renameSchema = z.object({ name: z.string().trim().min(1).max(60) });
const pushActionSchema = z.object({ token: z.string().min(10).max(400) });

@Controller('voice-app')
@UseGuards(JwtAuthGuard, VoiceExperienceGuard)
export class VoiceAppController {
  constructor(
    private readonly app: VoiceAppService,
    private readonly settings: VoiceAppSettingsService,
    private readonly contacts: VoiceAppContactsService,
    private readonly devices: VoiceAppDevicesService,
    private readonly calls: VoiceAppCallsService,
  ) {}

  @Get('bootstrap')
  bootstrap(@Req() req: VoiceActorRequest) {
    return this.app.bootstrap(voiceActor(req));
  }

  @Get('unread')
  unread(@Req() req: VoiceActorRequest) {
    return this.app.unread(req.user.id);
  }

  @Post('read')
  @HttpCode(204)
  async read(
    @Req() req: VoiceActorRequest,
    @Body(new ZodValidationPipe(voiceReadMarkerSchema)) body: z.infer<typeof voiceReadMarkerSchema>,
  ): Promise<void> {
    await this.app.markRead(req.user.id, body.key);
  }

  // Calls

  @Get('calls')
  callLog(
    @Req() req: VoiceActorRequest,
    @Query(new ZodValidationPipe(callsQuerySchema)) query: z.infer<typeof callsQuerySchema>,
  ) {
    return this.app.calls(req.user.id, query);
  }

  @Post('calls/:callSid/ring-here')
  @HttpCode(200)
  ringHere(
    @Req() req: VoiceActorRequest,
    @Param('callSid', new ZodValidationPipe(callSidSchema)) callSid: string,
  ) {
    return this.calls.ringHere(req.user.id, callSid);
  }

  @Post('calls/:callSid/decline')
  @HttpCode(200)
  decline(
    @Req() req: VoiceActorRequest,
    @Param('callSid', new ZodValidationPipe(callSidSchema)) callSid: string,
  ) {
    return this.calls.decline(req.user.id, callSid);
  }

  @Post('calls/:callSid/answered')
  @HttpCode(204)
  async answered(
    @Req() req: VoiceActorRequest,
    @Param('callSid', new ZodValidationPipe(callSidSchema)) callSid: string,
    @Body(new ZodValidationPipe(voiceCallAnsweredSchema))
    body: z.infer<typeof voiceCallAnsweredSchema>,
  ): Promise<void> {
    await this.calls.reportAnswered(req.user.id, callSid, body.deviceId);
  }

  // Voicemail

  @Get('voicemail')
  voicemail(
    @Req() req: VoiceActorRequest,
    @Query(new ZodValidationPipe(pageSchema)) query: z.infer<typeof pageSchema>,
  ) {
    return this.app.voicemail(req.user.id, query);
  }

  @Get('voicemail/:id/media')
  async voicemailMedia(
    @Req() req: VoiceActorRequest,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const media = await this.app.voicemailMedia(req.user.id, id);
    res.setHeader('Content-Type', media.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${media.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    media.stream.pipe(res);
  }

  @Post('voicemail/:id/heard')
  @HttpCode(204)
  async heard(@Req() req: VoiceActorRequest, @Param('id') id: string): Promise<void> {
    await this.app.markVoicemailHeard(req.user.id, id);
  }

  // Messages

  @Get('conversations')
  conversations(@Req() req: VoiceActorRequest) {
    return this.app.conversations(req.user.id);
  }

  @Get('conversations/:counterpart')
  thread(
    @Req() req: VoiceActorRequest,
    @Param('counterpart', new ZodValidationPipe(voicePhoneNumberSchema)) counterpart: string,
    @Query(new ZodValidationPipe(pageSchema)) query: z.infer<typeof pageSchema>,
  ) {
    return this.app.thread(req.user.id, counterpart, query);
  }

  @Post('messages')
  @HttpCode(201)
  @Throttle({ short: { limit: 20, ttl: 60_000 } })
  send(
    @Req() req: VoiceActorRequest,
    @Body(new ZodValidationPipe(voiceSendMessageSchema))
    body: z.infer<typeof voiceSendMessageSchema>,
  ) {
    return this.app.sendMessage(voiceActor(req), body.to, body.body);
  }

  // Settings

  @Get('settings')
  getSettings(@Req() req: VoiceActorRequest) {
    return this.settings.getSettings(req.user.id);
  }

  @Patch('settings')
  updateSettings(
    @Req() req: VoiceActorRequest,
    @Body(new ZodValidationPipe(voiceSettingsUpdateSchema))
    body: z.infer<typeof voiceSettingsUpdateSchema>,
  ) {
    return this.settings.updateSettings(voiceActor(req), body);
  }

  @Put('settings/greeting')
  saveGreeting(
    @Req() req: VoiceActorRequest,
    @Body(new ZodValidationPipe(voiceGreetingUploadSchema))
    body: z.infer<typeof voiceGreetingUploadSchema>,
  ) {
    return this.settings.saveGreeting(voiceActor(req), body);
  }

  @Delete('settings/greeting')
  deleteGreeting(@Req() req: VoiceActorRequest) {
    return this.settings.deleteGreeting(voiceActor(req));
  }

  @Get('settings/greeting/audio')
  async greetingAudio(@Req() req: VoiceActorRequest, @Res() res: Response) {
    const greeting = await this.settings.greetingAudio(req.user.id);
    res.setHeader('Content-Type', greeting.contentType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(greeting.audio);
  }

  // Blocked numbers

  @Get('blocked')
  blocked(@Req() req: VoiceActorRequest) {
    return this.settings.listBlocked(req.user.id);
  }

  @Post('blocked')
  @HttpCode(201)
  block(
    @Req() req: VoiceActorRequest,
    @Body(new ZodValidationPipe(blockNumberSchema)) body: z.infer<typeof blockNumberSchema>,
  ) {
    return this.settings.block(voiceActor(req), body.number);
  }

  @Delete('blocked/:number')
  @HttpCode(204)
  async unblock(
    @Req() req: VoiceActorRequest,
    @Param('number', new ZodValidationPipe(voicePhoneNumberSchema)) number: string,
  ): Promise<void> {
    await this.settings.unblock(voiceActor(req), number);
  }

  // Linked phones

  @Get('forwarding')
  forwarding(@Req() req: VoiceActorRequest) {
    return this.settings.listForwarding(req.user.id);
  }

  @Post('forwarding')
  @HttpCode(201)
  addForwarding(
    @Req() req: VoiceActorRequest,
    @Body(new ZodValidationPipe(forwardingCreateSchema))
    body: z.infer<typeof forwardingCreateSchema>,
  ) {
    return this.settings.addForwarding(voiceActor(req), body);
  }

  @Patch('forwarding/:id')
  updateForwarding(
    @Req() req: VoiceActorRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(forwardingUpdateSchema))
    body: z.infer<typeof forwardingUpdateSchema>,
  ) {
    return this.settings.updateForwarding(voiceActor(req), id, body);
  }

  @Delete('forwarding/:id')
  @HttpCode(204)
  async removeForwarding(@Req() req: VoiceActorRequest, @Param('id') id: string): Promise<void> {
    await this.settings.removeForwarding(voiceActor(req), id);
  }

  @Post('forwarding/:id/verify')
  @HttpCode(200)
  @Throttle({ short: { limit: 4, ttl: 60_000 } })
  verifyForwarding(@Req() req: VoiceActorRequest, @Param('id') id: string) {
    return this.settings.startVerification(voiceActor(req), id);
  }

  // Contacts

  @Get('contacts')
  listContacts(@Req() req: VoiceActorRequest) {
    return this.contacts.list(req.user.id);
  }

  @Post('contacts')
  @HttpCode(201)
  createContact(
    @Req() req: VoiceActorRequest,
    @Body(new ZodValidationPipe(contactUpsertSchema)) body: z.infer<typeof contactUpsertSchema>,
  ) {
    return this.contacts.create(voiceActor(req), body);
  }

  @Post('contacts/import')
  @HttpCode(200)
  importContacts(
    @Req() req: VoiceActorRequest,
    @Body(new ZodValidationPipe(contactImportSchema)) body: z.infer<typeof contactImportSchema>,
  ) {
    return this.contacts.import(voiceActor(req), body);
  }

  @Put('contacts/:id')
  updateContact(
    @Req() req: VoiceActorRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(contactUpsertSchema)) body: z.infer<typeof contactUpsertSchema>,
  ) {
    return this.contacts.update(voiceActor(req), id, body);
  }

  @Delete('contacts/:id')
  @HttpCode(204)
  async deleteContact(@Req() req: VoiceActorRequest, @Param('id') id: string): Promise<void> {
    await this.contacts.remove(voiceActor(req), id);
  }

  // Devices

  @Get('devices')
  listDevices(@Req() req: VoiceActorRequest) {
    return this.devices.list(req.user.id);
  }

  @Put('devices/:id')
  @HttpCode(204)
  async checkIn(
    @Req() req: VoiceActorRequest,
    @Param('id', new ZodValidationPipe(deviceIdSchema)) id: string,
    @Body(new ZodValidationPipe(voiceDeviceUpsertSchema))
    body: z.infer<typeof voiceDeviceUpsertSchema>,
  ): Promise<void> {
    await this.devices.checkIn(voiceActor(req), id, body);
  }

  @Patch('devices/:id')
  @HttpCode(204)
  async renameDevice(
    @Req() req: VoiceActorRequest,
    @Param('id', new ZodValidationPipe(deviceIdSchema)) id: string,
    @Body(new ZodValidationPipe(renameSchema)) body: z.infer<typeof renameSchema>,
  ): Promise<void> {
    await this.devices.rename(voiceActor(req), id, body.name);
  }

  @Delete('devices/:id')
  @HttpCode(204)
  async removeDevice(
    @Req() req: VoiceActorRequest,
    @Param('id', new ZodValidationPipe(deviceIdSchema)) id: string,
  ): Promise<void> {
    await this.devices.remove(voiceActor(req), id);
  }

  @Put('devices/:id/push')
  @HttpCode(204)
  async subscribe(
    @Req() req: VoiceActorRequest,
    @Param('id', new ZodValidationPipe(deviceIdSchema)) id: string,
    @Body(new ZodValidationPipe(voicePushSubscriptionSchema))
    body: z.infer<typeof voicePushSubscriptionSchema>,
  ): Promise<void> {
    await this.devices.subscribe(voiceActor(req), id, body);
  }

  @Delete('devices/:id/push')
  @HttpCode(204)
  async unsubscribe(
    @Req() req: VoiceActorRequest,
    @Param('id', new ZodValidationPipe(deviceIdSchema)) id: string,
  ): Promise<void> {
    await this.devices.unsubscribe(voiceActor(req), id);
  }
}

/**
 * The notification's Decline button. The service worker has no session, so
 * the push carries a short-lived token for this one call.
 */
@Controller('voice-app/push-actions')
export class VoiceAppPushActionsController {
  constructor(
    private readonly push: VoicePushService,
    private readonly calls: VoiceAppCallsService,
  ) {}

  @Post('decline')
  @HttpCode(200)
  @Throttle({ short: { limit: 20, ttl: 60_000 } })
  decline(@Body(new ZodValidationPipe(pushActionSchema)) body: z.infer<typeof pushActionSchema>) {
    const action = this.push.verifyActionToken(body.token);
    if (!action) throw new UnauthorizedException();
    return this.calls.decline(action.userId, action.callSid);
  }
}
