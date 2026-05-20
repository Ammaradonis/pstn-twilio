'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.WS_EVENTS = void 0;
exports.WS_EVENTS = {
  // server → client
  NUMBER_CREATED: 'number.created',
  NUMBER_UPDATED: 'number.updated',
  NUMBER_DELETED: 'number.deleted',
  SMS_RECEIVED: 'sms.received',
  SMS_SENT: 'sms.sent',
  SMS_STATUS_UPDATED: 'sms.status.updated',
  CALL_INBOUND_RINGING: 'call.inbound.ringing',
  CALL_OUTBOUND_STARTED: 'call.outbound.started',
  CALL_STATUS_UPDATED: 'call.status.updated',
  TWILIO_WEBHOOK_ERROR: 'twilio.webhook.error',
  SYSTEM_HEALTH_CHANGED: 'system.health.changed',
  // client → server
  CLIENT_PRESENCE: 'client.presence',
  VOICE_DEVICE_READY: 'voice.device.ready',
  VOICE_DEVICE_UNAVAILABLE: 'voice.device.unavailable',
};
//# sourceMappingURL=index.js.map
